/**
 * Activity history: the file behind the deploy and logs tabs.
 *
 * The interesting properties are not "can it write a line" but what happens
 * around the edges: a corrupt line must not hide the good ones, the retention
 * window must keep the newest records, and a failing write must not turn a
 * successful deployment into a failed request.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityHistory } from '../src/activity/history.ts'

/** The record shape used by these tests. */
interface Record {
  at: number
  label: string
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-history-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('append and read', () => {
  it('reads nothing from an absent history', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    expect(history.read()).toEqual([])
  })

  it('returns the newest record first', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'first' })
    history.append({ at: 2, label: 'second' })
    history.append({ at: 3, label: 'third' })
    const read = history.read()
    expect(read.map(item => item.label)).toEqual(['third', 'second', 'first'])
  })

  it('honours the requested limit', () => {
    const history = new ActivityHistory<Record>(dir, 'logs')
    for (let index = 0; index < 10; index += 1) history.append({ at: index, label: `r${String(index)}` })
    expect(history.read(3).map(item => item.label)).toEqual(['r9', 'r8', 'r7'])
  })

  it('creates its parent directory on first append', () => {
    const nested = join(dir, 'a', 'b')
    const history = new ActivityHistory<Record>(nested, 'deploys')
    history.append({ at: 1, label: 'x' })
    expect(existsSync(history.path)).toBe(true)
    expect(history.read()).toHaveLength(1)
  })

  it('keeps the two histories separate', () => {
    const deploys = new ActivityHistory<Record>(dir, 'deploys')
    const logs = new ActivityHistory<Record>(dir, 'logs')
    deploys.append({ at: 1, label: 'deploy' })
    logs.append({ at: 1, label: 'log' })
    expect(deploys.read().map(item => item.label)).toEqual(['deploy'])
    expect(logs.read().map(item => item.label)).toEqual(['log'])
    expect(deploys.path).not.toBe(logs.path)
  })

  it('round-trips a record with nested arrays', () => {
    const history = new ActivityHistory<{ hosts: Array<{ alias: string; lines: string[] }> }>(dir, 'logs')
    const record = { hosts: [{ alias: 'alpha', lines: ['a', 'b'] }] }
    history.append(record)
    expect(history.read()[0]).toEqual(record)
  })
})

describe('corruption tolerance', () => {
  it('skips an unparsable line instead of losing the whole file', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'good' })
    // A crash mid-write leaves a truncated trailing line; the records before
    // it must still be readable.
    writeFileSync(history.path, `${readFileSync(history.path, 'utf8')}{"at":2,"lab`, 'utf8')
    const read = history.read()
    expect(read).toHaveLength(1)
    expect(read[0].label).toBe('good')
  })

  it('survives a file that is entirely garbage', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'x' })
    writeFileSync(history.path, 'not json at all\n', 'utf8')
    expect(history.read()).toEqual([])
  })

  it('ignores blank lines', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'x' })
    writeFileSync(history.path, `\n\n${readFileSync(history.path, 'utf8')}\n\n`, 'utf8')
    expect(history.read()).toHaveLength(1)
  })
})

describe('retention', () => {
  it('keeps the newest records once the cap is exceeded', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    // 100 is the retention cap; writing past it must drop the oldest.
    for (let index = 0; index < 120; index += 1) history.append({ at: index, label: `r${String(index)}` })
    const read = history.read(200)
    expect(read.length).toBeLessThanOrEqual(100)
    expect(read[0].label).toBe('r119')
    // The oldest record must be gone, not merely hidden by the read limit.
    expect(read.some(item => item.label === 'r0')).toBe(false)
    expect(read.some(item => item.label === 'r119')).toBe(true)
  })

  it('does not rewrite the file below the cap', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'x' })
    const before = readFileSync(history.path, 'utf8')
    history.append({ at: 2, label: 'y' })
    expect(readFileSync(history.path, 'utf8')).toBe(`${before}{"at":2,"label":"y"}\n`)
  })
})

describe('clear', () => {
  it('empties the history', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'x' })
    history.clear()
    expect(history.read()).toEqual([])
  })

  it('is a no-op when the file does not exist', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.clear()
    expect(history.read()).toEqual([])
  })
})

describe('write failures must not fail the caller', () => {
  it('does not throw when the path cannot be written', () => {
    // A file where a directory is needed: append cannot create the parent.
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'x', 'utf8')
    const history = new ActivityHistory<Record>(join(blocker, 'sub'), 'deploys')
    expect(() => { history.append({ at: 1, label: 'x' }) }).not.toThrow()
    // History is a convenience; a successful deployment must stay successful.
    expect(history.read()).toEqual([])
  })

  it('reads nothing when the file cannot be read', () => {
    const history = new ActivityHistory<Record>(dir, 'deploys')
    history.append({ at: 1, label: 'x' })
    // Replace the file with a directory: reads fail, and must degrade to [].
    rmSync(history.path)
    mkdirSync(history.path)
    expect(history.read()).toEqual([])
  })
})