/**
 * Inspection check and retention tests.
 *
 * The check parsers are pure functions over command output, so every case
 * runs without a server. The retention tests write real history files.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CHECKS,
  findCheck,
  formatValue,
  isBreached,
  parseNumber,
  toCheckResult,
} from '../src/inspect/checks.ts'
import { Inspector, selectChecks, type InspectionRound } from '../src/inspect/inspection.ts'

describe('parseNumber', () => {
  it('reads a bare number', () => {
    expect(parseNumber('42')).toBe(42)
  })

  it('reads a percentage', () => {
    expect(parseNumber('71%')).toBe(71)
  })

  it('reads a decimal', () => {
    expect(parseNumber('1.75')).toBe(1.75)
  })

  it('returns null when there is no number', () => {
    expect(parseNumber('no data here')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
})

describe('isBreached', () => {
  it('flags a percentage above the watermark', () => {
    const check = findCheck('disk-usage')!
    expect(isBreached(check, 91)).toBe(true)
    expect(isBreached(check, 50)).toBe(false)
  })

  it('flags a gauge below the watermark', () => {
    const check = findCheck('uptime')!
    expect(isBreached(check, 60)).toBe(true)
    expect(isBreached(check, 100_000)).toBe(false)
  })

  it('treats an unknown value as not breached', () => {
    const check = findCheck('disk-usage')!
    expect(isBreached(check, null)).toBe(false)
  })

  it('treats a stopped service as breached', () => {
    const check = findCheck('sshd-running')!
    expect(isBreached(check, false)).toBe(true)
    expect(isBreached(check, true)).toBe(false)
  })

  it('never breaches a text check', () => {
    const check = findCheck('kernel')!
    expect(isBreached(check, '6.1.0')).toBe(false)
  })
})

describe('toCheckResult', () => {
  it('parses a successful command', () => {
    const check = findCheck('disk-usage')!
    const result = toCheckResult(check, 'web-01', {
      success: true, exitCode: 0, timedOut: false, stdout: '71%\n', stderr: '', durationMs: 12,
    })
    expect(result.value).toBe(71)
    expect(result.breached).toBe(false)
    expect(result.alias).toBe('web-01')
  })

  it('flags a breach', () => {
    const check = findCheck('disk-usage')!
    const result = toCheckResult(check, 'web-01', {
      success: true, exitCode: 0, timedOut: false, stdout: '93%\n', stderr: '', durationMs: 12,
    })
    expect(result.breached).toBe(true)
  })

  it('records an error without a value', () => {
    const check = findCheck('disk-usage')!
    const result = toCheckResult(check, 'web-01', {
      success: false, exitCode: null, timedOut: false, stdout: '', stderr: 'no route to host',
      durationMs: 5000, error: 'connect failed',
    })
    expect(result.value).toBeNull()
    expect(result.breached).toBe(false)
    expect(result.error).toBe('connect failed')
  })
})

describe('formatValue', () => {
  it('renders a percentage with its unit', () => {
    expect(formatValue(findCheck('disk-usage')!, 71)).toBe('71%')
  })

  it('renders an unknown value', () => {
    expect(formatValue(findCheck('disk-usage')!, null)).toBe('未知')
  })

  it('renders a boolean', () => {
    expect(formatValue(findCheck('sshd-running')!, true)).toBe('正常')
    expect(formatValue(findCheck('sshd-running')!, false)).toBe('异常')
  })
})

describe('selectChecks', () => {
  it('returns every check when nothing is selected', () => {
    expect(selectChecks()).toHaveLength(BUILTIN_CHECKS.length)
    expect(selectChecks([])).toHaveLength(BUILTIN_CHECKS.length)
  })

  it('returns only the requested checks', () => {
    expect(selectChecks(['disk-usage']).map(check => check.id)).toEqual(['disk-usage'])
  })

  it('refuses an unknown check id', () => {
    expect(() => selectChecks(['nope'])).toThrow(/unknown check/)
  })
})

describe('Inspector', () => {
  /** Build a round with the given disk values per host. */
  function round(startedAt: number, values: Record<string, number>): InspectionRound {
    return {
      startedAt,
      durationMs: 100,
      targets: Object.keys(values),
      results: Object.entries(values).map(([alias, value]) => ({
        checkId: 'disk-usage',
        alias,
        value,
        breached: value > 85,
        raw: `${value}%`,
      })),
    }
  }

  it('appends and reads rounds oldest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    inspector.append(round(2, { 'web-01': 50 }))
    const rounds = inspector.read()
    expect(rounds).toHaveLength(2)
    expect(rounds[0]?.startedAt).toBe(1)
    expect(rounds[1]?.startedAt).toBe(2)
  })

  it('reports a changed value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    inspector.append(round(2, { 'web-01': 50 }))
    const changes = inspector.diff()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.before).toBe('40%')
    expect(changes[0]?.after).toBe('50%')
  })

  it('reports a new breach', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    inspector.append(round(2, { 'web-01': 91 }))
    const changes = inspector.diff()
    expect(changes[0]?.stateChange).toBe('new-breach')
  })

  it('reports a recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 91 }))
    inspector.append(round(2, { 'web-01': 40 }))
    const changes = inspector.diff()
    expect(changes[0]?.stateChange).toBe('recovered')
  })

  it('reports nothing when the value did not change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    inspector.append(round(2, { 'web-01': 40 }))
    expect(inspector.diff()).toHaveLength(0)
  })

  it('reports a newly seen host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    inspector.append(round(2, { 'web-01': 40, 'web-02': 30 }))
    const changes = inspector.diff()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.alias).toBe('web-02')
  })

  it('returns nothing when fewer than two rounds exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const inspector = new Inspector(join(dir, 'history.jsonl'))
    inspector.append(round(1, { 'web-01': 40 }))
    expect(inspector.diff()).toHaveLength(0)
  })

  it('survives a truncated history line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-inspect-'))
    const path = join(dir, 'history.jsonl')
    const inspector = new Inspector(path)
    inspector.append(round(1, { 'web-01': 40 }))
    // A crash mid-write leaves a partial line.
    writeFileSync(path, readFileSync(path, 'utf8') + '{"startedAt":2,"results":[', 'utf8')
    const rounds = inspector.read()
    expect(rounds).toHaveLength(1)
  })
})
