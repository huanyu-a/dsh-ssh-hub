/**
 * Live end-to-end verification of the monitoring chain against the running
 * DSH instance.
 *
 * Not a test file: this is the manual proof that the *installed* plugin — not
 * the source tree the tests import — collects, aggregates and reports
 * correctly. It starts an SSH server on a loopback port, registers it through
 * the plugin's own HTTP API, triggers a round, and then reads back the
 * status, the inspection history, the metric tiers and the security posture.
 *
 * Run with the same node the profile uses:
 *
 *   node scripts/verify-monitor.mjs
 *
 * Exits non-zero on the first broken link, so it is usable as a smoke gate
 * after a reinstall.
 */

import { createServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
// ssh2 is CommonJS: a named ESM import only works under a bundler/test
// transform, so a plain `node` run needs the default-import form.
import ssh2 from 'ssh2'

const { Server } = ssh2

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:44425'
const API = `${BASE}/api/dsh-ssh`
/** The alias used for the temporary host (the store rejects leading/trailing underscores). */
const ALIAS = 'verify-monitor-tmp'

/** Fail the whole run with one line. */
function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

/** Print a passing step. */
function pass(message) {
  console.log(`ok    ${message}`)
}

/** The server's host key. */
const hostKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/**
 * Answer each built-in check with the value its pipeline would print.
 *
 * @param {string} command - the command the server received.
 * @returns {string} stdout.
 */
function responder(command) {
  if (command.includes('df -P /')) return '93\n'
  if (command.includes('/proc/loadavg')) return '0.11\n'
  if (command.includes('df -i')) return '15\n'
  if (command.includes('/proc/uptime')) return '90000\n'
  if (command.includes('--failed')) return '0\n'
  if (command.includes('systemctl')) return 'active\n'
  if (command.includes('free')) return '48\n'
  if (command.includes('uname -sr')) return 'Linux 6.1.0-verify\n'
  if (command.includes('uname')) return 'Linux\n'
  return ''
}

/** Start the fake server and return its port plus a stop function. */
async function startServer() {
  const received = []
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    connection.on('error', () => {})
    connection.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'verify-secret') { ctx.accept(); return }
      ctx.reject(['password'])
    })
    connection.on('ready', () => {
      connection.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          received.push(info.command)
          const stream = acceptExec()
          stream.write(responder(info.command))
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { port: server.address().port, received, stop: () => new Promise((r) => { server.close(r) }) }
}

/** Remove a host if it exists; a missing host is not a failure. */
async function removeHost(alias) {
  const response = await fetch(`${API}/hosts?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
  // 400/404 both mean "no such host": the clean-up is best-effort by design.
  if (response.ok) return true
  const text = await response.text()
  if (text.includes('not found')) return false
  fail(`DELETE /hosts -> HTTP ${response.status} ${text}`)
}

/** Call a route and parse its JSON. */
async function call(path, init) {
  const response = await fetch(`${API}${path}`, init)
  const text = await response.text()
  if (!response.ok) fail(`${path} -> HTTP ${response.status} ${text}`)
  return text === '' ? null : JSON.parse(text)
}

const server = await startServer()
console.log(`fake ssh server on 127.0.0.1:${server.port}`)

// Start clean: a leftover host from a previous run would make the counts
// below ambiguous.
const removedStale = await removeHost(ALIAS)
if (removedStale) console.log('      removed a host left by a previous run')

// --- register the host through the plugin's own API -----------------------
const created = await call('/hosts', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    alias: ALIAS,
    host: '127.0.0.1',
    port: server.port,
    user: 'tester',
    auth: { kind: 'password', password: 'verify-secret' },
  }),
})
if (created?.host?.alias !== ALIAS) fail('host was not created')
pass(`host registered via POST /hosts`)

// --- the monitoring routes answer ----------------------------------------
const before = await call('/monitor')
pass(`monitor status: running=${before.running} interval=${before.intervalMs}ms hosts=${before.hosts}`)

// --- run one round through the timer's own path --------------------------
const tick = await call('/monitor/tick', { method: 'POST' })
if (tick?.ran !== true) fail(`the round did not run: ${JSON.stringify(tick)}`)
if (tick.hosts < 1) fail(`the round covered no hosts: ${JSON.stringify(tick)}`)
pass(`round ran: ${tick.hosts} host, ${tick.breaches} breach, ${tick.blind} blind`)

// 93% disk is over the 85% watermark, so the breach count must be non-zero —
// a round that reports 0 breaches against this responder is a parser bug.
if (tick.breaches < 1) fail('disk at 93% was not reported as a breach')
if (server.received.length < 8) fail(`only ${server.received.length} commands reached the server`)
pass(`${server.received.length} probe commands reached the real server`)

// --- the round was persisted --------------------------------------------
const rounds = await call('/inspection?limit=5')
if (!Array.isArray(rounds.rounds) || rounds.rounds.length < 1) fail('the round was not persisted')
const latest = rounds.rounds[0]
if (!latest.results.some((result) => result.checkId === 'disk-usage' && result.value === 93)) {
  fail(`the persisted round does not carry the disk value: ${JSON.stringify(latest.results.slice(0, 3))}`)
}
pass(`round persisted with ${latest.results.length} results`)

// --- metrics rolled up ---------------------------------------------------
const metrics = await call(`/metrics?alias=${encodeURIComponent(ALIAS)}&tier=1m&metric=disk-usage`)
if (!Array.isArray(metrics.series) || metrics.series.length < 1) {
  fail(`no 1m metric bucket: ${JSON.stringify(metrics)}`)
}
if (metrics.series.at(-1).value !== 93) {
  fail(`the metric value is ${metrics.series.at(-1).value}, expected 93`)
}
pass(`metric tier 1m carries ${metrics.series.length} bucket(s), latest=93`)

// --- alerts evaluated ----------------------------------------------------
const alerts = await call('/alerts')
if (!Array.isArray(alerts.states)) fail('alert states are not an array')
pass(`alert states: ${alerts.states.length}, events: ${alerts.events.length}`)

// --- the change set ------------------------------------------------------
const diff = await call('/inspection/diff')
if (!Array.isArray(diff.changes)) fail('diff changes are not an array')
pass(`diff reports ${diff.changes.length} change(s)`)

// --- security posture is honest ------------------------------------------
const security = await call('/security')
const encrypted = security.encryptConfigured && security.secret.available
pass(`security: encrypt=${security.encryptConfigured} secret=${security.secret.source} policy=${security.hostKeyPolicy} audit=${security.auditEnabled}`)
if (!encrypted) {
  console.log('      (plaintext storage: encryptCredentials and a master secret must BOTH be set)')
}

// --- clean up ------------------------------------------------------------
await removeHost(ALIAS)
await server.stop()
console.log('\nVERIFY OK  monitoring chain works end to end through the running plugin')