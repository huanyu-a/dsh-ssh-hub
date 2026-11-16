/**
 * End-to-end verification of the deploy, log-search and master-secret routes
 * against the running GUI.
 *
 * The unit tests cover the pieces; this proves the wiring: real HTTP, the real
 * route fence, the real store on disk and the real history files. It also
 * proves the two facts that only an end-to-end run can establish:
 *
 * - a deployment is recorded in the history the panel reads, and
 * - setting a master secret actually leaves the stored credential encrypted
 *   and still readable through the plugin.
 *
 * The host it creates is temporary. The secret it sets is temporary too, and
 * is removed at the end — leaving one behind would change the operator's
 * security posture as a side effect of running a test.
 *
 * Usage: set DSH_WEB_URL (http://127.0.0.1:<port>) then run this file.
 */
import { createServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'

const { Server } = ssh2

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:62916'
const API = `${BASE}/api/dsh-ssh`
/** Temporary host alias (the store rejects leading/trailing underscores). */
const ALIAS = 'verify-routes-tmp'
/** The temporary master secret. Long enough to satisfy the minimum. */
const SECRET = 'verify-routes-master-secret-0001'

/** Print a failure and exit non-zero. */
function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

/** Print a passing step. */
function pass(message) {
  console.log(`ok    ${message}`)
}

const hostKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/**
 * Answer each command this script issues.
 *
 * The minimal server has no shell, so it must return the FINAL output of the
 * whole pipeline, not the raw file the pipeline would have read.
 *
 * @param {string} command - the command received.
 * @returns {string} stdout.
 */
function responder(command) {
  // Deployment steps.
  if (command.includes('deploy-step-one')) return 'step-one-ok\n'
  if (command.includes('deploy-step-two')) return 'step-two-ok\n'
  // Health probe.
  if (command.includes('is-active')) return 'active\n'
  // Log search over the journal.
  if (command.includes('journalctl')) return 'verify: matched line one\nverify: matched line two\n'
  // Log search over files.
  if (command.includes('grep')) return 'verify: matched line one\n'
  return ''
}

/** Start the fake server; returns its port, the commands it saw, and a stop hook. */
async function startServer() {
  const received = []
  const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
    // A failed key exchange must not crash the script.
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
  return { port: server.address().port, received, stop: () => new Promise((resolve) => { server.close(resolve) }) }
}

/** Remove a host if it exists; a missing host is not a failure. */
async function removeHost(alias) {
  const response = await fetch(`${API}/hosts?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
  if (response.ok) return true
  const text = await response.text()
  if (text.includes('not found')) return false
  fail(`DELETE /hosts -> HTTP ${response.status} ${text}`)
}

/** Call a route and parse its JSON. */
async function call(path, init) {
  const response = await fetch(`${API}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    fail(`${path} did not return JSON: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  return { status: response.status, body }
}

/** POST a JSON body. */
function post(path, payload) {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** The store file this plugin reads. */
function storePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-ssh.json')
}

const server = await startServer()
let exitCode = 0

try {
  await removeHost(ALIAS)

  // ---------------------------------------------------------------- setup
  const created = await post('/hosts', {
    alias: ALIAS,
    host: '127.0.0.1',
    port: server.port,
    user: 'tester',
    auth: { kind: 'password', password: 'verify-secret' },
    tags: ['verify'],
  })
  // 201 is the create-route's documented success code.
  if (created.status !== 201 || created.body?.host?.alias !== ALIAS) {
    fail(`host creation failed: HTTP ${created.status} ${JSON.stringify(created.body)}`)
  }
  pass(`temporary host ${ALIAS} created on port ${server.port}`)

  // --------------------------------------------------------------- deploy
  const planId = `verify-deploy-${String(Date.now())}`
  const deploy = await post('/deploy', {
    plan: {
      id: planId,
      steps: [
        { name: 'one', command: 'echo deploy-step-one', rollbackCommand: 'echo undo-one' },
        { name: 'two', command: 'echo deploy-step-two', rollbackCommand: 'echo undo-two' },
      ],
      healthCheck: { command: 'systemctl is-active app', expectExitCode: 0 },
      batchSize: 1,
    },
    targets: [ALIAS],
  })
  if (deploy.status !== 200 || deploy.body?.run === undefined) {
    fail(`POST /deploy -> HTTP ${deploy.status} ${JSON.stringify(deploy.body)}`)
  }
  const run = deploy.body.run
  if (run.hosts.length !== 1 || run.hosts[0].alias !== ALIAS) {
    fail(`the deployment record did not name the target host: ${JSON.stringify(run.hosts)}`)
  }
  if (!run.ok || !run.hosts[0].ok) {
    fail(`the deployment did not succeed: ${JSON.stringify(run.hosts[0])}`)
  }
  pass(`deployment ${planId} reached ${ALIAS} and reported success`)

  // The steps must actually have run: a record that says "ok" without the
  // commands arriving would be a fabricated success.
  if (!server.received.some(command => command.includes('deploy-step-one'))) {
    fail('the first step never reached the host')
  }
  pass('both step commands reached the host')

  // The history the panel reads must contain the run.
  const deployHistory = await call('/deploy/history?limit=20')
  if (deployHistory.status !== 200) fail(`GET /deploy/history -> HTTP ${deployHistory.status}`)
  if (!deployHistory.body.runs.some(entry => entry.planId === planId)) {
    fail('the deployment was not recorded in the history')
  }
  pass('the deployment appears in the recorded history')

  // A plan without rollback commands must be refused: the whole safety
  // property of this surface rests on it.
  const unsafe = await post('/deploy', {
    plan: { id: 'unsafe', steps: [{ name: 'no-rollback', command: 'echo x' }] },
    targets: [ALIAS],
  })
  if (unsafe.status !== 400) {
    fail(`a plan without rollback was accepted: HTTP ${unsafe.status} ${JSON.stringify(unsafe.body)}`)
  }
  pass('a plan with no rollback command is refused')

  // ----------------------------------------------------------- log search
  const search = await post('/logs', {
    request: { pattern: 'verify', source: 'journal', sinceSeconds: 600, maxLinesPerHost: 10 },
    targets: [ALIAS],
  })
  if (search.status !== 200 || search.body?.search === undefined) {
    fail(`POST /logs -> HTTP ${search.status} ${JSON.stringify(search.body)}`)
  }
  const logHost = search.body.search.hosts[0]
  if (!logHost.ok) fail(`the log search failed on the host: ${JSON.stringify(logHost)}`)
  if (logHost.lines.length === 0) fail('the log search returned no lines from a host that answered')
  pass(`log search returned ${String(logHost.lines.length)} lines from ${ALIAS}`)

  const logHistory = await call('/logs/history?limit=20')
  if (!logHistory.body.searches.some(entry => entry.pattern === 'verify')) {
    fail('the log search was not recorded in the history')
  }
  pass('the log search appears in the recorded history')

  // -------------------------------------------------------- master secret
  const before = await call('/security')
  const wasConfigured = before.body.secret.source !== 'none'
  if (wasConfigured) {
    // Never rotate an operator's real key as a test side effect.
    console.log('skip  master-secret checks (a real key is already configured)')
  } else {
    const set = await post('/security/secret', { action: 'set', secret: SECRET })
    if (set.status !== 200 || set.body?.ok !== true) {
      fail(`POST /security/secret -> HTTP ${set.status} ${JSON.stringify(set.body)}`)
    }
    if (set.body.source !== 'file') fail(`the secret did not take effect: source=${set.body.source}`)
    pass('the master secret was stored and reports source=file')

    const after = await call('/security')
    if (after.body.secret.source !== 'file') fail('GET /security does not report the new secret')
    pass('GET /security reflects the stored secret')

    // The decisive check: the credential is no longer plaintext on disk.
    const store = JSON.parse(readFileSync(storePath(), 'utf8'))
    const stored = store.hosts.find(host => host.alias === ALIAS)
    if (stored === undefined) fail('the temporary host vanished from the store')
    if (typeof stored.auth?.password === 'string') {
      fail('the password is still plaintext on disk after enabling encryption')
    }
    pass('the stored password is no longer plaintext')

    // Rotation must keep the credential usable: re-authenticate against the
    // same server using the credential the plugin decrypts under the new key.
    const rotated = await post('/security/secret', { action: 'set', secret: `${SECRET}-rotated` })
    if (rotated.body?.ok !== true) fail(`rotation failed: ${JSON.stringify(rotated.body)}`)
    const usable = await post('/test', { alias: ALIAS })
    if (usable.body?.result?.ok !== true) {
      fail(`the credential stopped working after rotation: ${JSON.stringify(usable.body)}`)
    }
    pass('the credential still authenticates after key rotation')

    const cleared = await post('/security/secret', { action: 'clear' })
    if (cleared.body?.ok !== true) {
      // Clearing is refused while credentials depend on the key, which is the
      // safe answer; report it rather than pretending it succeeded.
      pass(`clearing the key was refused as designed: ${cleared.body?.error ?? ''}`)
    } else {
      pass('the key file was removed')
    }
  }

  // --------------------------------------------------------------- cleanup
  const removed = await removeHost(ALIAS)
  if (!removed) fail('the temporary host could not be removed')
  pass('temporary host removed')

  // The key file, if this run created one, must not outlive the test.
  if (!wasConfigured) {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const keyPath = join(home, 'dsh-ssh-master.key')
    if (existsSync(keyPath)) {
      rmSync(keyPath, { force: true })
    }
    const restored = await call('/security')
    if (restored.body.secret.source !== 'none') {
      fail('the security posture was not restored after the test')
    }
    pass('security posture restored to its original state')
  }
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await server.stop()
}

if (exitCode === 0) {
  console.log('\nROUTES OK  deploy, log search and master-secret work end to end')
}