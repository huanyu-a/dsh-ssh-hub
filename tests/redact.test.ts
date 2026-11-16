/**
 * Output-redaction tests.
 *
 * The shapes here are what a secret actually looks like in command output;
 * each case is a real-world form, not a synthetic one.
 */

import { describe, expect, it } from 'vitest'
import { matchedRules, redactCommand, redactOutput } from '../src/security/redact.ts'

describe('redactOutput', () => {
  it('redacts an env-style password assignment', () => {
    const line = 'DB_PASSWORD={{SECRET_erzpitdv}}\n'
    const redacted = redactOutput(line)
    expect(redacted).not.toContain('{{SECRET_erzpitdv}}')
    expect(redacted).toContain('[REDACTED]')
  })

  it('redacts several secrets on separate lines', () => {
    const output = [
      'API_KEY={{SECRET_2izbdq4u}}',
      'APP_SECRET={{SECRET_mlddso2n}}',
      'SAFE=value',
    ].join('\n')
    const redacted = redactOutput(output)
    expect(redacted).not.toContain('{{SECRET_2izbdq4u}}')
    expect(redacted).not.toContain('{{SECRET_mlddso2n}}')
    // A value that is not a secret must survive.
    expect(redacted).toContain('SAFE=value')
  })

  it('redacts an AWS access key id', () => {
    expect(redactOutput('AWS key AKIAIOSFODNN7EXAMPLE here')).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts a bearer token', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
    expect(redactOutput(`Authorization: Bearer ${token}`)).not.toContain(token)
  })

  it('redacts a private key block', () => {
    // The BEGIN/END markers are what the rule keys on, so the test builds
    // them from parts rather than embedding a literal block.
    const dashes = '-'.repeat(5)
    const begin = `${dashes}BEGIN PRIVATE KEY${dashes}`
    const end = `${dashes}END PRIVATE KEY${dashes}`
    const key = [begin, 'AAAA', 'BBBB', end].join('\n')
    const redacted = redactOutput(key)
    expect(redacted).toContain('[REDACTED PRIVATE KEY]')
    expect(redacted).not.toContain('AAAA')
    expect(redacted).not.toContain('BBBB')
  })

  it('redacts a password inside a connection string', () => {
    const redacted = redactOutput('postgres://app:{{SECRET_gnorbfxs}}@db.internal:5432/app')
    expect(redacted).not.toContain('{{SECRET_gnorbfxs}}')
    expect(redacted).toContain('[REDACTED]')
  })

  it('leaves ordinary output alone', () => {
    const output = 'uptime: 12 days\nload average: 0.15 0.20 0.25\n'
    expect(redactOutput(output)).toBe(output)
  })

  it('handles an empty output', () => {
    expect(redactOutput('')).toBe('')
  })

  it('reports which rules matched', () => {
    expect(matchedRules('DB_PASSWORD={{SECRET_erzpitdv}}')).toContain('password-assignment')
    expect(matchedRules('nothing sensitive here')).toHaveLength(0)
  })
})

describe('redactCommand', () => {
  it('redacts a mysql -p argument', () => {
    const redacted = redactCommand('mysql -u root -p hunter2 mydb')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).toContain('-p [REDACTED]')
  })

  it('redacts a --password argument', () => {
    expect(redactCommand('psql --password hunter2')).not.toContain('hunter2')
  })

  it('redacts an inline authorization header', () => {
    const redacted = redactCommand("curl -H 'Authorization: Bearer abc123' https://api")
    expect(redacted).not.toContain('abc123')
  })

  it('leaves an ordinary command alone', () => {
    expect(redactCommand('systemctl status nginx')).toBe('systemctl status nginx')
  })
})
