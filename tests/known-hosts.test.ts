/**
 * known_hosts parsing and host-key decision tests.
 *
 * The parser is pure over a file path, so every case here is a real file in
 * a temp directory — no mocking of the filesystem.
 *
 * The key vectors are real ed25519 public keys generated with ssh-keygen:
 * the blob base64-encoded in a known_hosts line is byte-identical to the
 * blob ssh2 hands to `hostVerifier`, which is what the module relies on.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createHostVerifier,
  decide,
  entriesFor,
  fingerprint,
  parseKnownHosts,
  recordKnownHost,
} from '../src/security/known-hosts.ts'

/** Real ed25519 host keys (ssh-keygen generated). */
const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIIJoJt+9yP2vRFbtcdGNb/vPsAlFJ+NZpG72lQ7Zl9cu'
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIOQLJqGOhBuCDIWkJD4QQpZbOcB3lDd7rzRE5dqtbMDw'
const KEY_TYPE = 'ssh-ed25519'

/** Write a known_hosts file into a fresh temp dir and return its path. */
function writeKnownHosts(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kh-'))
  const path = join(dir, 'known_hosts')
  writeFileSync(path, contents, 'utf8')
  return path
}

/**
 * Build the blob ssh2 passes to `hostVerifier`.
 *
 * The KEX reply carries the SSH public-key blob — `string(keyType) ||
 * string(keyMaterial)` — which is byte-for-byte the blob OpenSSH stores
 * base64-encoded in a known_hosts line. This helper therefore just decodes
 * that known_hosts blob; no re-framing happens on the way to the verifier.
 */
function serverKeyBlob(knownHostsBase64: string): Buffer {
  return Buffer.from(knownHostsBase64, 'base64')
}

describe('parseKnownHosts', () => {
  it('reads plain entries', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(file.present).toBe(true)
    expect(file.entries).toHaveLength(1)
    expect(file.entries[0]?.patterns).toEqual(['web-01'])
    expect(file.entries[0]?.keyType).toBe(KEY_TYPE)
  })

  it('splits comma-separated host patterns', () => {
    const path = writeKnownHosts(`web-01,web-02 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(file.entries[0]?.patterns).toEqual(['web-01', 'web-02'])
  })

  it('reads the bracket port form', () => {
    const path = writeKnownHosts(`[web-01]:2222 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(file.entries[0]?.patterns).toEqual(['[web-01]:2222'])
  })

  it('reads the revoked marker', () => {
    const path = writeKnownHosts(`@revoked web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(file.entries[0]?.revoked).toBe(true)
  })

  it('ignores comments, blank lines and malformed entries', () => {
    const path = writeKnownHosts([
      '# a comment',
      '',
      'garbage',
      `web-01 ${KEY_TYPE} ${KEY_A}`,
    ].join('\n'))
    const file = parseKnownHosts(path)
    expect(file.entries).toHaveLength(1)
  })

  it('reports an absent file as not present', () => {
    const file = parseKnownHosts(join(tmpdir(), 'dsh-kh-does-not-exist', 'known_hosts'))
    expect(file.present).toBe(false)
    expect(file.entries).toEqual([])
  })
})

describe('entriesFor', () => {
  it('matches an exact host', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(entriesFor(file, 'web-01', 22)).toHaveLength(1)
    expect(entriesFor(file, 'web-02', 22)).toHaveLength(0)
  })

  it('matches a wildcard pattern', () => {
    const path = writeKnownHosts(`*.prod ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(entriesFor(file, 'web-01.prod', 22)).toHaveLength(1)
    expect(entriesFor(file, 'web-01.staging', 22)).toHaveLength(0)
  })

  it('matches the bracket port form only on its own port', () => {
    const path = writeKnownHosts(`[web-01]:2222 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(entriesFor(file, 'web-01', 2222)).toHaveLength(1)
    expect(entriesFor(file, 'web-01', 22)).toHaveLength(0)
  })
})

describe('fingerprint', () => {
  it('is stable and base64 without padding', () => {
    const value = fingerprint(KEY_A)
    expect(value.startsWith('SHA256:')).toBe(true)
    expect(value).not.toContain('=')
    expect(value).toBe(fingerprint(KEY_A))
    expect(value).not.toBe(fingerprint(KEY_B))
  })
})

describe('decide', () => {
  it('accepts a matching key', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(decide(file, 'web-01', 22, KEY_TYPE, KEY_A)).toEqual({ action: 'accept' })
  })

  it('reports a mismatch with both fingerprints', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    const decision = decide(file, 'web-01', 22, KEY_TYPE, KEY_B)
    expect(decision.action).toBe('mismatch')
    if (decision.action !== 'mismatch') return
    expect(decision.expected).toBe(fingerprint(KEY_A))
    expect(decision.received).toBe(fingerprint(KEY_B))
  })

  it('reports an unknown host', () => {
    const path = writeKnownHosts(`other ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(decide(file, 'web-01', 22, KEY_TYPE, KEY_A).action).toBe('unknown')
  })

  it('reports a revoked key', () => {
    const path = writeKnownHosts(`@revoked web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const file = parseKnownHosts(path)
    expect(decide(file, 'web-01', 22, KEY_TYPE, KEY_A).action).toBe('revoked')
  })
})

describe('createHostVerifier', () => {
  it('accepts a known key under every policy', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const verifier = createHostVerifier({ policy: 'strict', path, host: 'web-01', port: 22 })
    expect(verifier(serverKeyBlob(KEY_A))).toBe(true)
  })

  it('refuses a changed key even under the off policy', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const verifier = createHostVerifier({ policy: 'off', path, host: 'web-01', port: 22 })
    expect(verifier(serverKeyBlob(KEY_B))).toBe(false)
  })

  it('refuses an unknown key under the strict policy', () => {
    const path = writeKnownHosts(`other ${KEY_TYPE} ${KEY_A}\n`)
    const verifier = createHostVerifier({ policy: 'strict', path, host: 'web-01', port: 22 })
    expect(verifier(serverKeyBlob(KEY_A))).toBe(false)
  })

  it('records an unknown key under the tofu policy', () => {
    const path = writeKnownHosts('')
    const recorded: string[] = []
    const verifier = createHostVerifier({
      policy: 'tofu',
      path,
      host: 'web-01',
      port: 22,
      onRecord: (host, _port, keyType, key) => { recorded.push(`${host}:${keyType}:${key}`) },
    })
    expect(verifier(serverKeyBlob(KEY_A))).toBe(true)
    expect(recorded).toHaveLength(1)
  })

  it('fails closed when the key blob is malformed', () => {
    const path = writeKnownHosts(`web-01 ${KEY_TYPE} ${KEY_A}\n`)
    const verifier = createHostVerifier({ policy: 'tofu', path, host: 'web-01', port: 22 })
    expect(verifier(Buffer.from([0, 0, 0]))).toBe(false)
  })
})

describe('recordKnownHost', () => {
  it('appends the plain form for port 22', () => {
    const path = writeKnownHosts('')
    recordKnownHost(path, 'web-01', 22, KEY_TYPE, KEY_A)
    const file = parseKnownHosts(path)
    expect(file.entries[0]?.patterns).toEqual(['web-01'])
    expect(file.entries[0]?.key).toBe(KEY_A)
  })

  it('appends the bracket form for a non-standard port', () => {
    const path = writeKnownHosts('')
    recordKnownHost(path, 'web-01', 2222, KEY_TYPE, KEY_A)
    const file = parseKnownHosts(path)
    expect(file.entries[0]?.patterns).toEqual(['[web-01]:2222'])
  })

  it('records a key the verifier then accepts', () => {
    const path = writeKnownHosts('')
    recordKnownHost(path, 'web-01', 22, KEY_TYPE, KEY_A)
    const verifier = createHostVerifier({ policy: 'strict', path, host: 'web-01', port: 22 })
    expect(verifier(serverKeyBlob(KEY_A))).toBe(true)
  })
})
