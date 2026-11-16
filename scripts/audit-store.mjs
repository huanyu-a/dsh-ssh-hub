/**
 * Audit the credential store's secrecy state.
 *
 * Run after a test that touched encryption: it answers the only question that
 * matters for data safety — is anything on disk sealed with a key that is no
 * longer available? A sealed value with no key is an unreadable credential,
 * which is indistinguishable from a lost password.
 *
 * Usage: node scripts/audit-store.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const storePath = join(home, 'dsh-ssh.json')
const keyPath = join(home, 'dsh-ssh-master.key')
const namedFile = process.env.DSH_SSH_HUB_SECRET_FILE
const envSecret = process.env.DSH_SSH_HUB_SECRET

/** Report whether a stored secret is an envelope object. */
function shape(value) {
  if (value === undefined) return 'absent'
  if (typeof value === 'string') return 'PLAINTEXT'
  if (typeof value === 'object' && value !== null) return 'sealed'
  return `unexpected:${typeof value}`
}

const secretSource = typeof envSecret === 'string' && envSecret.length > 0
  ? 'env'
  : existsSync(typeof namedFile === 'string' && namedFile.length > 0 ? namedFile : keyPath)
    ? 'file'
    : 'none'

console.log(`store   : ${storePath}`)
console.log(`key     : ${keyPath} (exists: ${existsSync(keyPath)})`)
console.log(`secret  : ${secretSource}`)
console.log('')

if (!existsSync(storePath)) {
  console.log('no store file')
  process.exit(0)
}

const parsed = JSON.parse(readFileSync(storePath, 'utf8'))
const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : []
let sealed = 0
let plaintext = 0
for (const host of hosts) {
  const auth = host.auth ?? {}
  const password = shape(auth.password)
  const passphrase = shape(auth.passphrase)
  if (password === 'sealed' || passphrase === 'sealed') sealed += 1
  if (password === 'PLAINTEXT' || passphrase === 'PLAINTEXT') plaintext += 1
  const changed = host.updatedAt === host.createdAt ? '' : '  (edited since creation)'
  console.log(
    `${String(host.alias).padEnd(24)} kind=${String(auth.kind).padEnd(9)}`
    + ` password=${password.padEnd(10)} passphrase=${passphrase}${changed}`,
  )
}

console.log('')
console.log(`hosts=${String(hosts.length)} sealed=${String(sealed)} plaintext=${String(plaintext)}`)
// The dangerous combination, stated explicitly rather than left to be read off
// the table: sealed data plus no key is unrecoverable.
if (sealed > 0 && secretSource === 'none') {
  console.log('')
  console.log(`ORPHANED  ${String(sealed)} host(s) are sealed but no master key exists — those credentials cannot be decrypted.`)
  process.exit(2)
}
process.exit(0)
