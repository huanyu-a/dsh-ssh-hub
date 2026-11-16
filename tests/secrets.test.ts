/**
 * Secret-envelope and audit-log tests.
 *
 * Both modules are pure file I/O, so every case runs against real files in
 * a temp directory.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSealed, open, seal } from '../src/security/secrets.ts'
import { AuditLog, redact } from '../src/audit/audit-log.ts'

describe('seal / open', () => {
  it('round-trips a secret', () => {
    const envelope = seal('hunter2', 'master-secret')
    expect(open(envelope, 'master-secret')).toBe('hunter2')
  })

  it('never stores the plaintext in the envelope', () => {
    const envelope = seal('hunter2', 'master-secret')
    const serialised = JSON.stringify(envelope)
    expect(serialised).not.toContain('hunter2')
  })

  it('produces a different envelope each time', () => {
    const a = seal('hunter2', 'master-secret')
    const b = seal('hunter2', 'master-secret')
    expect(a.data).not.toBe(b.data)
    expect(a.iv).not.toBe(b.iv)
    // Both still decrypt to the same value.
    expect(open(a, 'master-secret')).toBe('hunter2')
    expect(open(b, 'master-secret')).toBe('hunter2')
  })

  it('refuses to decrypt with the wrong master secret', () => {
    const envelope = seal('hunter2', 'master-secret')
    expect(() => open(envelope, 'wrong-secret')).toThrow(/cannot be decrypted/)
  })

  it('detects a tampered ciphertext', () => {
    const envelope = seal('hunter2', 'master-secret')
    const bytes = Buffer.from(envelope.data, 'base64')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff
    const tampered = { ...envelope, data: bytes.toString('base64') }
    expect(() => open(tampered, 'master-secret')).toThrow(/cannot be decrypted/)
  })

  it('rejects an unsupported version', () => {
    const envelope = seal('hunter2', 'master-secret')
    expect(() => open({ ...envelope, v: 99 }, 'master-secret')).toThrow(/unsupported secret envelope version/)
  })

  it('rejects a malformed envelope', () => {
    expect(() => open({ v: 1, alg: 'aes-256-gcm', salt: '', iv: '', tag: '', data: '' }, 'x')).toThrow(/malformed/)
  })

  it('recognises an envelope', () => {
    expect(isSealed(seal('x', 'y'))).toBe(true)
    expect(isSealed('plaintext')).toBe(false)
    expect(isSealed(undefined)).toBe(false)
  })
})

describe('redact', () => {
  it('redacts a password assignment', () => {
    expect(redact('mysql -u root --password=hunter2 db')).toBe('mysql -u root --password=[REDACTED] db')
  })

  it('redacts a quoted password', () => {
    expect(redact('echo "s3cret" | sudo -S true')).toContain('[REDACTED]')
    expect(redact('echo "s3cret" | sudo -S true')).not.toContain('s3cret')
  })

  it('redacts a bearer token', () => {
    expect(redact('curl -H "Authorization: Bearer abc123def456ghi"')).not.toContain('abc123def456ghi')
  })

  it('redacts a pasted private key', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
    expect(redact(`cat <<EOF\n${key}\nEOF`)).toContain('[REDACTED PRIVATE KEY]')
  })

  it('leaves an ordinary command alone', () => {
    expect(redact('systemctl status nginx')).toBe('systemctl status nginx')
  })
})

describe('AuditLog', () => {
  it('appends and reads records newest last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const log = new AuditLog(join(dir, 'audit.log'))
    log.append({ ts: 1, action: 'exec', actor: 'user', targets: ['a'], ok: true, summary: 'first' })
    log.append({ ts: 2, action: 'exec', actor: 'user', targets: ['b'], ok: true, summary: 'second' })
    const records = log.read()
    expect(records).toHaveLength(2)
    expect(records[0]?.summary).toBe('first')
    expect(records[1]?.summary).toBe('second')
  })

  it('redacts the summary before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const path = join(dir, 'audit.log')
    const log = new AuditLog(path)
    log.append({
      ts: 1,
      action: 'exec',
      actor: 'user',
      targets: ['a'],
      ok: true,
      summary: 'ran mysql --password=hunter2',
    })
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(log.read()[0]?.summary).toContain('[REDACTED]')
  })

  it('redacts secrets inside detail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const path = join(dir, 'audit.log')
    const log = new AuditLog(path)
    log.append({
      ts: 1,
      action: 'exec',
      actor: 'user',
      targets: ['a'],
      ok: true,
      summary: 'ok',
      detail: { command: 'mysql --password=hunter2', exitCode: 0 },
    })
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(log.read()[0]?.detail?.exitCode).toBe(0)
  })

  it('reads an empty log without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const log = new AuditLog(join(dir, 'missing.log'))
    expect(log.read()).toEqual([])
  })

  it('keeps going when the log cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
    const log = new AuditLog(join(dir, 'audit.log'))
    log.append({ ts: 1, action: 'exec', actor: 'user', targets: [], ok: true, summary: 'ok' })
    // Make the path unwritable by turning it into a directory.
    rmSync(log.path, { force: true })
    mkdirSync(log.path)
    log.append({ ts: 2, action: 'exec', actor: 'user', targets: [], ok: true, summary: 'ok' })
    expect(log.lastError).toBeDefined()
  })
})
