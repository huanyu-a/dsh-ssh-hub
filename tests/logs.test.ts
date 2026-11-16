/**
 * Cross-host log search tests.
 *
 * The command builder and the output parser are pure, so they are tested
 * directly; the fan-out is tested against a fake engine.
 */

import { describe, expect, it } from 'vitest'
import {
  buildSearchCommand,
  formatSince,
  parseSearchOutput,
  searchLogs,
  shellQuote,
} from '../src/logs/search.ts'
import type { SshEngine } from '../src/engine.ts'
import type { ExecResult } from '../src/protocol.ts'

describe('shellQuote', () => {
  it('quotes a plain value', () => {
    expect(shellQuote('nginx')).toBe("'nginx'")
  })

  it('escapes a single quote', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('buildSearchCommand', () => {
  it('builds a journal search', () => {
    const command = buildSearchCommand({ source: 'journal', pattern: 'timeout' })
    expect(command).toContain('journalctl')
    expect(command).toContain("grep -F -- 'timeout'")
    expect(command).toContain('grep -c -F')
  })

  it('filters the journal by unit', () => {
    const command = buildSearchCommand({ source: 'journal', pattern: 'x', unit: 'nginx' })
    expect(command).toContain("--unit 'nginx'")
  })

  it('filters the journal by time', () => {
    const command = buildSearchCommand({ source: 'journal', pattern: 'x', since: 1_700_000_000 })
    expect(command).toContain('--since')
    expect(command).toContain('2023-11-14')
  })

  it('builds a file search with a default directory', () => {
    const command = buildSearchCommand({ source: 'files', pattern: 'error' })
    expect(command).toContain("grep -R -F")
    expect(command).toContain("'/var/log'")
  })

  it('honours a custom directory', () => {
    const command = buildSearchCommand({ source: 'files', pattern: 'error', directory: '/srv/app/logs' })
    expect(command).toContain("'/srv/app/logs'")
  })

  it('bounds the output with head', () => {
    const command = buildSearchCommand({ source: 'journal', pattern: 'x', maxLinesPerHost: 10 })
    expect(command).toContain('head -n 10')
  })

  it('quotes a pattern that contains shell metacharacters', () => {
    const command = buildSearchCommand({ source: 'journal', pattern: 'a; rm -rf /' })
    // The pattern must be a single quoted argument, so the metacharacters
    // never reach the shell.
    expect(command).toContain("'a; rm -rf /'")
  })
})

describe('formatSince', () => {
  it('produces an ISO timestamp', () => {
    expect(formatSince(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('parseSearchOutput', () => {
  it('splits the lines from the count', () => {
    const stdout = 'line one\nline two\n2\n'
    expect(parseSearchOutput(stdout, 50)).toEqual({ lines: ['line one', 'line two'], total: 2, truncated: false })
  })

  it('marks output truncated when more matched than were shown', () => {
    const stdout = 'line one\nline two\n500\n'
    const parsed = parseSearchOutput(stdout, 2)
    expect(parsed.truncated).toBe(true)
    expect(parsed.total).toBe(500)
  })

  it('handles a search with no matches', () => {
    expect(parseSearchOutput('0\n', 50)).toEqual({ lines: [], total: 0, truncated: false })
  })

  it('handles empty output', () => {
    expect(parseSearchOutput('', 50)).toEqual({ lines: [], total: 0, truncated: false })
  })

  it('keeps every line when the output has no count footer', () => {
    const parsed = parseSearchOutput('only line\n', 50)
    expect(parsed.lines).toEqual(['only line'])
  })
})

/** A fake engine that returns scripted output per host. */
function fakeEngine(outputs: Record<string, Partial<ExecResult>>): SshEngine {
  return {
    exec: async (alias: string): Promise<ExecResult> => {
      const scripted = outputs[alias]
      return {
        success: scripted?.success ?? true,
        exitCode: scripted?.exitCode ?? 0,
        timedOut: false,
        stdout: scripted?.stdout ?? '0\n',
        stderr: scripted?.stderr ?? '',
        durationMs: 5,
        ...(scripted?.error !== undefined ? { error: scripted.error } : {}),
      }
    },
    store: { list: () => [] },
  } as unknown as SshEngine
}

describe('searchLogs', () => {
  it('aggregates matches across hosts', async () => {
    const engine = fakeEngine({
      'web-01': { stdout: 'boom\n1\n' },
      'web-02': { stdout: 'boom\nboom\n2\n' },
    })
    const result = await searchLogs(engine, { source: 'journal', pattern: 'boom' }, ['web-01', 'web-02'])
    expect(result.ok).toBe(true)
    expect(result.totalLines).toBe(3)
    expect(result.results[0]?.alias).toBe('web-01')
    expect(result.results[1]?.lines).toHaveLength(2)
  })

  it('keeps the results in target order', async () => {
    const engine = fakeEngine({
      'a': { stdout: 'x\n1\n' },
      'b': { stdout: 'y\n1\n' },
    })
    const result = await searchLogs(engine, { source: 'journal', pattern: 'x' }, ['b', 'a'])
    expect(result.results.map(host => host.alias)).toEqual(['b', 'a'])
  })

  it('records a host failure without failing the whole search', async () => {
    const engine = fakeEngine({
      'web-01': { success: false, exitCode: null, error: 'connect failed' },
      'web-02': { stdout: 'ok\n1\n' },
    })
    const result = await searchLogs(engine, { source: 'journal', pattern: 'x' }, ['web-01', 'web-02'])
    expect(result.ok).toBe(true)
    expect(result.results[0]?.ok).toBe(false)
    expect(result.results[0]?.error).toBe('connect failed')
    expect(result.results[1]?.lines).toHaveLength(1)
  })

  it('reports truncation', async () => {
    const engine = fakeEngine({ 'web-01': { stdout: 'one\ntwo\n900\n' } })
    const result = await searchLogs(engine, { source: 'journal', pattern: 'x', maxLinesPerHost: 2 }, ['web-01'])
    expect(result.truncated).toBe(true)
  })

  it('handles an empty target list', async () => {
    const engine = fakeEngine({})
    const result = await searchLogs(engine, { source: 'journal', pattern: 'x' }, [])
    expect(result.totalLines).toBe(0)
    expect(result.results).toEqual([])
  })
})
