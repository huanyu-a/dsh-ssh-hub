/**
 * HostStore credential-encryption tests.
 *
 * The store is pure file I/O, so each case builds a real store in a temp
 * directory and inspects the bytes that actually land on disk.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore, type SecretProtector } from '../src/store.ts'
import { open, seal } from '../src/security/secrets.ts'

/** A protector backed by the real envelope, with a fixed test master secret. */
const TEST_SECRET = 'test-master-secret'

function protector(): SecretProtector {
  return {
    seal: plaintext => seal(plaintext, TEST_SECRET),
    open: stored => (typeof stored === 'object' && stored !== null ? open(stored as never, TEST_SECRET) : undefined),
  }
}

/** A fresh store in its own temp directory. */
function freshStore(withProtector: boolean): HostStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
  const path = join(dir, 'dsh-ssh.json')
  return new HostStore(path, undefined, withProtector ? protector() : undefined)
}

const PASSWORD_HOST = {
  alias: 'web-01',
  host: '10.0.0.1',
  user: 'root',
  auth: { kind: 'password' as const, password: 'hunter2' },
}

const KEY_HOST = {
  alias: 'web-02',
  host: '10.0.0.2',
  user: 'deploy',
  auth: { kind: 'key' as const, keyPath: '/home/u/.ssh/id_ed25519', passphrase: 'keypass' },
}

describe('HostStore without a protector', () => {
  it('keeps the base plugin plaintext behaviour', () => {
    const store = freshStore(false)
    store.create(PASSWORD_HOST)
    const raw = readFileSync(store.path, 'utf8')
    // The base plugin wrote plaintext; without a protector this must not change.
    expect(raw).toContain('hunter2')
    expect(store.find('web-01')?.auth.password).toBe('hunter2')
  })
})

describe('HostStore with a protector', () => {
  it('never writes the password to disk in plaintext', () => {
    const store = freshStore(true)
    store.create(PASSWORD_HOST)
    const raw = readFileSync(store.path, 'utf8')
    expect(raw).not.toContain('hunter2')
    // The in-memory view still hands the SSH layer the real password.
    expect(store.find('web-01')?.auth.password).toBe('hunter2')
  })

  it('never writes a key passphrase in plaintext', () => {
    const store = freshStore(true)
    store.create(KEY_HOST)
    const raw = readFileSync(store.path, 'utf8')
    expect(raw).not.toContain('keypass')
    expect(store.find('web-02')?.auth.passphrase).toBe('keypass')
  })

  it('round-trips an update that changes the password', () => {
    const store = freshStore(true)
    store.create(PASSWORD_HOST)
    store.update('web-01', { auth: { kind: 'password', password: 'newpass' } })
    const raw = readFileSync(store.path, 'utf8')
    expect(raw).not.toContain('newpass')
    expect(raw).not.toContain('hunter2')
    expect(store.find('web-01')?.auth.password).toBe('newpass')
  })

  it('round-trips an update that leaves the password alone', () => {
    const store = freshStore(true)
    store.create(PASSWORD_HOST)
    store.update('web-01', { tags: ['prod'] })
    expect(store.find('web-01')?.auth.password).toBe('hunter2')
    expect(store.find('web-01')?.tags).toEqual(['prod'])
  })

  it('keeps the key passphrase when only the description changes', () => {
    const store = freshStore(true)
    store.create(KEY_HOST)
    store.update('web-02', { description: 'builder' })
    expect(store.find('web-02')?.auth.passphrase).toBe('keypass')
    expect(store.find('web-02')?.description).toBe('builder')
  })

  it('reads a store written before encryption was enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
    const path = join(dir, 'dsh-ssh.json')
    // A pre-encryption store: plaintext secrets on disk.
    writeFileSync(path, JSON.stringify({
      version: 1,
      hosts: [{
        alias: 'legacy',
        host: '10.0.0.9',
        port: 22,
        user: 'root',
        auth: { kind: 'password', password: 'oldplain' },
        proxyJump: [],
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    }), 'utf8')
    const store = new HostStore(path, undefined, protector())
    // A plaintext value passes straight through: it is not a sealed envelope.
    expect(store.find('legacy')?.auth.password).toBe('oldplain')
  })

  it('re-seals a legacy plaintext secret on the next update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-store-'))
    const path = join(dir, 'dsh-ssh.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      hosts: [{
        alias: 'legacy',
        host: '10.0.0.9',
        port: 22,
        user: 'root',
        auth: { kind: 'password', password: 'oldplain' },
        proxyJump: [],
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      }],
    }), 'utf8')
    const store = new HostStore(path, undefined, protector())
    store.update('legacy', { description: 'migrated' })
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('oldplain')
    expect(store.find('legacy')?.auth.password).toBe('oldplain')
  })

  it('does not attach secrets to the secret-free summary', () => {
    const store = freshStore(true)
    store.create(PASSWORD_HOST)
    const summary = store.summarize(store.find('web-01')!)
    expect(JSON.stringify(summary)).not.toContain('hunter2')
  })
})