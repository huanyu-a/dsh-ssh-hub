/**
 * Does the live plugin read the master secret per operation, or keep the one it
 * saw at mount?
 *
 * The difference is not academic: a protector that captured its key keeps
 * sealing with it after the key file is rotated or deleted, which leaves
 * credentials encrypted under a key nothing on disk can reproduce. This walks
 * the exact transitions — no key, key set, key gone again — and reports what
 * lands on disk each time.
 *
 * It creates and removes its own temporary hosts and never touches an existing
 * one. The key file it writes is removed at the end.
 *
 * Usage: set DSH_WEB_URL, then node scripts/verify-secret-liveness.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:62916'
const API = `${BASE}/api/dsh-ssh`
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const storePath = join(home, 'dsh-ssh.json')
const keyPath = join(home, 'dsh-ssh-master.key')

/** POST JSON and parse the reply. */
async function post(path, payload) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { status: response.status, raw: text }
  }
}

/** Read one host's stored credential shape straight from the file. */
function storedShape(alias) {
  const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
  const host = parsed.hosts.find(candidate => candidate.alias === alias)
  const value = host?.auth?.password
  if (value === undefined) return 'absent'
  return typeof value === 'string' ? 'plaintext' : 'sealed'
}

/** Create a throwaway host and report how its password was stored. */
async function trial(label) {
  const alias = `probe-live-${label}`
  await fetch(`${API}/hosts?alias=${alias}`, { method: 'DELETE' })
  const created = await post('/hosts', {
    alias,
    host: '127.0.0.1',
    port: 1,
    user: 'probe',
    auth: { kind: 'password', password: 'probe-secret-value' },
  })
  const shape = created?.host?.alias === alias ? storedShape(alias) : `create failed: ${JSON.stringify(created)}`
  await fetch(`${API}/hosts?alias=${alias}`, { method: 'DELETE' })
  return shape
}

/** The live security view. */
async function security() {
  const response = await fetch(`${API}/security`)
  return response.json()
}

const before = await security()
console.log(`start: key file ${existsSync(keyPath) ? 'present' : 'absent'}, reported source=${before.secret.source}`)

// --- 1. no key at all -----------------------------------------------------
if (!existsSync(keyPath)) {
  console.log(`1. create with no key          -> ${await trial('nokey')}   (expect plaintext)`)
}

// --- 2. a key the plugin writes itself ------------------------------------
const set = await post('/security/secret', { action: 'set', secret: 'probe-liveness-master-secret-0001' })
console.log(`2. set a key                   -> ok=${String(set.ok)} source=${set.source} rotated=${String(set.rotated)}`)
console.log(`   create with a key           -> ${await trial('withkey')}   (expect sealed)`)

// --- 3. the key disappears out from under the plugin ----------------------
// Deleting the file is what a mistaken cleanup, a restored backup or a rotated
// mount does. The next write is the one that decides whether the plugin was
// reading the secret live.
rmSync(keyPath, { force: true })
console.log(`3. key file deleted            -> reported source=${(await security()).secret.source}`)
console.log(`   create after the key vanished -> ${await trial('keygone')}   (expect plaintext)`)
