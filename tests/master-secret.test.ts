/**
 * Master-secret management: the operations that can lock an operator out of
 * their own credentials if they are wrong.
 *
 * The envelope itself is covered by secrets.test.ts. What this file pins down
 * is the layer above it: where the secret is read from, what a write refuses,
 * and what a rotation must not silently do.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostStore, type SecretProtector } from '../src/store.ts'
import { isSealed, open, seal } from '../src/security/secrets.ts'
import {
  MIN_SECRET_LENGTH,
  SECRET_ENV,
  SECRET_FILE_ENV,
  defaultKeyPath,
  findPlaintextEntries,
  generateSecret,
  masterSecretSource,
  readMasterSecret,
  readStoredAuth,
  removeMasterKey,
  rotateSecrets,
  writeMasterKey,
  type KeyWriteResult,
} from '../src/security/master-secret.ts'

let dir: string
let keyPath: string
let storePath: string

/** Build a protector bound to one secret, the way the host half does. */
function protector(secret: string): SecretProtector {
  return {
    seal: plaintext => seal(plaintext, secret),
    open: stored => (isSealed(stored) ? open(stored, secret) : undefined),
  }
}

/**
 * A protector that reads the key file on every call, which is what the host
 * half installs in production.
 *
 * The difference matters: a captured protector keeps sealing with the secret it
 * saw at mount, so rotation tests built on one would pass while the shipped
 * plugin quietly pinned itself to the first key it ever saw.
 */
function liveProtector(): SecretProtector {
  return {
    seal: (plaintext) => {
      const secret = readMasterSecret(keyPath)
      if (secret === undefined) return plaintext
      return seal(plaintext, secret)
    },
    open: (stored) => {
      if (!isSealed(stored)) return undefined
      const secret = readMasterSecret(keyPath)
      if (secret === undefined) return undefined
      return open(stored, secret)
    },
  }
}

/** Commit a secret by writing the key file, as the panel route does. */
function commit(secret: string): KeyWriteResult {
  return writeMasterKey(keyPath, secret, true)
}

/** Store a host with a password. */
function seedHost(store: HostStore, alias: string, password: string): void {
  store.create({
    alias,
    host: `${alias}.example.com`,
    user: 'root',
    auth: { kind: 'password', password },
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-secret-'))
  keyPath = defaultKeyPath(dir)
  storePath = join(dir, 'dsh-ssh.json')
  delete process.env[SECRET_ENV]
  delete process.env[SECRET_FILE_ENV]
})

afterEach(() => {
  delete process.env[SECRET_ENV]
  delete process.env[SECRET_FILE_ENV]
  rmSync(dir, { recursive: true, force: true })
})

describe('reading the master secret', () => {
  it('reports none when nothing is configured', () => {
    expect(masterSecretSource(keyPath)).toBe('none')
    expect(readMasterSecret(keyPath)).toBeUndefined()
  })

  it('prefers the environment secret over any file', () => {
    writeMasterKey(keyPath, 'file-secret-long-enough', false)
    process.env[SECRET_ENV] = 'env-secret-long-enough'
    expect(masterSecretSource(keyPath)).toBe('env')
    expect(readMasterSecret(keyPath)).toBe('env-secret-long-enough')
  })

  it('uses the key file the panel wrote when no env var is set', () => {
    writeMasterKey(keyPath, 'panel-secret-long-enough', false)
    expect(masterSecretSource(keyPath)).toBe('file')
    expect(readMasterSecret(keyPath)).toBe('panel-secret-long-enough')
  })

  it('honours an explicitly named secret file', () => {
    const named = join(dir, 'named.key')
    writeFileSync(named, 'named-secret-long-enough\n', 'utf8')
    process.env[SECRET_FILE_ENV] = named
    // A trailing newline must not become part of the derived key.
    expect(readMasterSecret(keyPath)).toBe('named-secret-long-enough')
    expect(masterSecretSource(keyPath)).toBe('file')
  })

  it('strips exactly one trailing newline', () => {
    writeFileSync(keyPath, 'secret-with-newlines-long\n', 'utf8')
    expect(readMasterSecret(keyPath)).toBe('secret-with-newlines-long')
  })

  it('treats an empty file as no secret', () => {
    writeFileSync(keyPath, '\n', 'utf8')
    expect(readMasterSecret(keyPath)).toBeUndefined()
  })
})

describe('writing the master key', () => {
  it('rejects a secret that is too short to matter', () => {
    const outcome = writeMasterKey(keyPath, 'short', false)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain(String(MIN_SECRET_LENGTH))
    expect(existsSync(keyPath)).toBe(false)
  })

  it('refuses to overwrite an existing key without permission', () => {
    writeFileSync(keyPath, 'original-secret-long-enough', 'utf8')
    const outcome = writeMasterKey(keyPath, 'replacement-secret-long-enough', false)
    expect(outcome.ok).toBe(false)
    // The original key must survive: overwriting it would strand every
    // credential sealed with it.
    expect(readFileSync(keyPath, 'utf8')).toBe('original-secret-long-enough')
  })

  it('overwrites when explicitly asked to', () => {
    writeFileSync(keyPath, 'original-secret-long-enough', 'utf8')
    const outcome = writeMasterKey(keyPath, 'replacement-secret-long-enough', true)
    expect(outcome.ok).toBe(true)
    expect(readMasterSecret(keyPath)).toBe('replacement-secret-long-enough')
  })

  it('creates missing parent directories', () => {
    const nested = join(dir, 'a', 'b', 'master.key')
    expect(writeMasterKey(nested, 'nested-secret-long-enough', false).ok).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  it('generates secrets that satisfy its own minimum length', () => {
    const generated = generateSecret()
    expect(generated.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
    // Two generations must differ, or the "random" key is a shared constant.
    expect(generateSecret()).not.toBe(generated)
  })
})

describe('finding plaintext credentials', () => {
  it('finds nothing in an absent store', () => {
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
  })

  it('lists hosts whose stored password is readable without a key', () => {
    const store = new HostStore(storePath)
    seedHost(store, 'plain-host', 'hunter2-long-enough')
    expect(findPlaintextEntries(storePath).aliases).toEqual(['plain-host'])
  })

  it('does not list hosts whose secrets are sealed', () => {
    const store = new HostStore(storePath, undefined, protector('sealed-secret-long-enough'))
    seedHost(store, 'sealed-host', 'hunter2-long-enough')
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
  })

  it('survives a corrupt store file rather than throwing', () => {
    writeFileSync(storePath, '{not json', 'utf8')
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
  })

  it('distinguishes a host with no secrets at all', () => {
    const store = new HostStore(storePath)
    store.create({ alias: 'keyonly', host: 'k.example.com', user: 'root', auth: { kind: 'agent' } })
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
  })
})

describe('rotating secrets', () => {
  it('re-encrypts every entry so the new secret opens them', () => {
    const oldSecret = 'old-secret-long-enough'
    const newSecret = 'new-secret-long-enough'
    writeMasterKey(keyPath, oldSecret, false)
    // The production shape: one protector that reads the key file per call.
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'alpha', 'alpha-password-long')
    seedHost(store, 'beta', 'beta-password-long')

    const outcome = rotateSecrets(store, oldSecret, newSecret, commit)
    expect(outcome.ok).toBe(true)
    expect(outcome.rotated).toBe(2)

    // The decisive check: a store sealed with the old secret must now open
    // with the new one. Without rotation this is where the operator loses
    // access, and no earlier assertion would catch it.
    const reopened = new HostStore(storePath, undefined, protector(newSecret))
    expect(reopened.find('alpha')?.auth.password).toBe('alpha-password-long')
    expect(reopened.find('beta')?.auth.password).toBe('beta-password-long')
  })

  it('leaves the store readable through the same live protector', () => {
    // The real process keeps one store instance for its whole life. After a
    // rotation that instance must still be able to read what it wrote, which
    // only holds if its protector resolves the secret rather than capturing it.
    writeMasterKey(keyPath, 'first-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'alpha', 'alpha-password-long')

    const outcome = rotateSecrets(store, 'first-secret-long-enough', 'second-secret-long-enough', commit)
    expect(outcome.ok).toBe(true)
    expect(store.find('alpha')?.auth.password).toBe('alpha-password-long')
  })

  it('stops sealing with the old key once the key file changes', () => {
    // Guards the defect this design replaced: a captured protector kept sealing
    // with a key that was no longer on disk, which orphaned every later write.
    writeMasterKey(keyPath, 'before-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    removeMasterKey(keyPath)
    seedHost(store, 'after-removal', 'password-long-enough')

    const stored = readStoredAuth(storePath, 'after-removal')
    // With no key there is nothing to encrypt with, so the credential is stored
    // as-is — a sealed value here would be undecryptable forever.
    expect(isSealed(stored?.password)).toBe(false)
    expect(findPlaintextEntries(storePath).aliases).toEqual(['after-removal'])
  })

  it('refuses a new secret that is too short', () => {
    writeMasterKey(keyPath, 'old-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'alpha', 'alpha-password-long')
    const outcome = rotateSecrets(store, 'old-secret-long-enough', 'tiny', commit)
    expect(outcome.ok).toBe(false)
    // Nothing may be rewritten when the request itself is invalid.
    expect(outcome.rotated).toBe(0)
    const reopened = new HostStore(storePath, undefined, protector('old-secret-long-enough'))
    expect(reopened.find('alpha')?.auth.password).toBe('alpha-password-long')
  })

  it('reports entries the old secret cannot open instead of dropping them', () => {
    writeMasterKey(keyPath, 'correct-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'alpha', 'alpha-password-long')
    // Rotate claiming a different old secret: every sealed entry is unreadable
    // with it, and that must be reported, not silently swallowed.
    const outcome = rotateSecrets(store, 'wrong-secret-long-enough', 'new-secret-long-enough', commit)
    expect(outcome.ok).toBe(false)
    expect(outcome.unreadable).toContain('alpha')
    // The key file must be untouched: nothing was proven safe.
    expect(readMasterSecret(keyPath)).toBe('correct-secret-long-enough')
  })

  it('restores the previous key when re-sealing fails', () => {
    writeMasterKey(keyPath, 'keep-me-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'alpha', 'alpha-password-long')
    // A store whose write fails stands in for a full disk or a revoked file
    // permission at the worst possible moment.
    const broken = Object.create(store) as HostStore
    Object.defineProperty(broken, 'path', { value: store.path })
    broken.list = () => store.list()
    broken.resealAll = () => { throw new Error('disk full') }

    const outcome = rotateSecrets(broken, 'keep-me-secret-long-enough', 'new-secret-long-enough', commit)
    expect(outcome.ok).toBe(false)
    // The store on disk is still sealed with the old key, so the old key has to
    // be the one left behind — anything else locks every host out at once.
    expect(readMasterSecret(keyPath)).toBe('keep-me-secret-long-enough')
    const reopened = new HostStore(storePath, undefined, protector('keep-me-secret-long-enough'))
    expect(reopened.find('alpha')?.auth.password).toBe('alpha-password-long')
  })

  it('handles an empty store without failing', () => {
    writeMasterKey(keyPath, 'old-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    const outcome = rotateSecrets(store, 'old-secret-long-enough', 'new-secret-long-enough', commit)
    expect(outcome.ok).toBe(true)
    expect(outcome.rotated).toBe(0)
  })
})

describe('a sealed credential with no key', () => {
  it('is dropped instead of being handed to the SSH layer', () => {
    // Seal a credential, then take the key away — a restored backup, a deleted
    // file, a different machine. The entry must not present the envelope as if
    // it were a password.
    writeMasterKey(keyPath, 'gone-secret-long-enough', false)
    const store = new HostStore(storePath, undefined, liveProtector())
    seedHost(store, 'locked', 'locked-password-long')
    removeMasterKey(keyPath)

    const entry = new HostStore(storePath, undefined, liveProtector()).find('locked')
    expect(entry?.auth.password).toBeUndefined()
    // And the state is reported, so the panel can say why rather than showing
    // a host that mysteriously refuses to authenticate.
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
  })
})

describe('removing the master key', () => {
  it('deletes the file', () => {
    writeMasterKey(keyPath, 'deletable-secret-long-enough', false)
    expect(removeMasterKey(keyPath).ok).toBe(true)
    expect(existsSync(keyPath)).toBe(false)
  })

  it('is a no-op when there is nothing to delete', () => {
    expect(removeMasterKey(keyPath).ok).toBe(true)
  })

  it('refuses while the environment provides the active secret', () => {
    writeMasterKey(keyPath, 'file-secret-long-enough', false)
    process.env[SECRET_ENV] = 'env-secret-long-enough'
    const outcome = removeMasterKey(keyPath)
    expect(outcome.ok).toBe(false)
    // Deleting the file would not disable encryption, so reporting success
    // would tell the operator something untrue.
    expect(existsSync(keyPath)).toBe(true)
  })
})

describe('default key path', () => {
  it('lives under the plugin home, not inside the credential store', () => {
    expect(defaultKeyPath(dir)).toBe(join(dir, 'dsh-ssh-master.key'))
    expect(defaultKeyPath(dir)).not.toBe(storePath)
  })
})

describe('end-to-end: panel sets a key on a plaintext store', () => {
  it('seals existing credentials and leaves them readable with the new key', () => {
    // The scenario the whole feature exists for: a store created before
    // encryption, then the operator sets a key in the panel.
    const plain = new HostStore(storePath)
    seedHost(plain, 'legacy', 'legacy-password-long')
    expect(findPlaintextEntries(storePath).aliases).toEqual(['legacy'])

    const secret = generateSecret()
    const written = writeMasterKey(keyPath, secret, false)
    expect(written.ok).toBe(true)

    // Re-open the store the way the host would with encryption enabled.
    const encrypted = new HostStore(storePath, undefined, protector(secret))
    const entry = encrypted.find('legacy')
    expect(entry?.auth.password).toBe('legacy-password-long')
    encrypted.update('legacy', { host: entry!.host, user: entry!.user, auth: entry!.auth })

    // Now nothing is plaintext, and the new key is the only way in.
    expect(findPlaintextEntries(storePath).aliases).toEqual([])
    const withoutKey = new HostStore(storePath)
    expect(withoutKey.find('legacy')?.auth.password).not.toBe('legacy-password-long')
  })
})