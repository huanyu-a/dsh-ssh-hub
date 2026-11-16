/**
 * Inspection fan-out: bounded concurrency and deterministic row order.
 *
 * The serial sweep was correct but slow enough to outlast its own monitoring
 * interval at fleet scale; the fix is a worker pool. Two properties then need
 * proving, because both are easy to lose in a later refactor and neither
 * shows up as a crash:
 *
 * 1. no more than N hosts are in flight at once (otherwise a 50-host fleet
 *    opens 50 sockets on a desktop machine),
 * 2. the rows come back in target/check order regardless of who answers first
 *    (the round diff compares rows across rounds).
 */
import { describe, expect, it } from 'vitest'
import { Inspector, DEFAULT_INSPECT_CONCURRENCY } from '../src/inspect/inspection.ts'
import type { SshEngine } from '../src/engine.ts'

/** A fake engine that records how many execs overlap and the completion order. */
function makeEngine(delayMs: (alias: string) => number) {
  let inFlight = 0
  let peak = 0
  const completed: string[] = []
  const engine = {
    exec: async (alias: string, _command: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise(resolve => setTimeout(resolve, delayMs(alias)))
        return { success: true, exitCode: 0, timedOut: false, stdout: '10', stderr: '', durationMs: 1 }
      } finally {
        inFlight -= 1
        // Recorded on the way out: this is completion order, which is what a
        // parallel fan-out scrambles.
        completed.push(alias)
      }
    },
  }
  return { engine: engine as unknown as SshEngine, peak: () => peak, completed: () => completed }
}

/** A round that runs against a temporary history file. */
function makeInspector() {
  // The history path is derived from the home dir; these tests only assert on
  // the returned round, so the on-disk append is harmless.
  return new Inspector()
}

describe('inspection fan-out', () => {
  it('never runs more hosts concurrently than the limit', async () => {
    const fake = makeEngine(() => 20)
    const targets = Array.from({ length: 30 }, (_, index) => `host-${String(index)}`)
    await makeInspector().run(fake.engine, targets, ['disk-usage'], 1000, 4)
    // The check itself is one command per host, so peak concurrency equals
    // the number of hosts in flight.
    expect(fake.peak()).toBeLessThanOrEqual(4)
    expect(fake.peak()).toBeGreaterThan(1)
  })

  it('defaults to a bounded limit rather than one worker per host', async () => {
    const fake = makeEngine(() => 15)
    const targets = Array.from({ length: DEFAULT_INSPECT_CONCURRENCY * 4 }, (_, index) => `h${String(index)}`)
    await makeInspector().run(fake.engine, targets, ['disk-usage'], 1000)
    expect(fake.peak()).toBeLessThanOrEqual(DEFAULT_INSPECT_CONCURRENCY)
  })

  it('returns rows in target order even when hosts answer out of order', async () => {
    // The first target answers last: completion order is the reverse of
    // target order, and the round must not inherit that.
    const fake = makeEngine(alias => (alias === 'slow' ? 30 : 5))
    const round = await makeInspector().run(fake.engine, ['slow', 'fast-a', 'fast-b'], ['disk-usage'], 1000, 3)
    expect(fake.completed()[0]).not.toBe('slow')
    expect(round.results.map(result => result.alias)).toEqual(['slow', 'fast-a', 'fast-b'])
  })

  it('keeps check order within a host', async () => {
    const fake = makeEngine(() => 2)
    const round = await makeInspector().run(
      fake.engine,
      ['alpha'],
      ['disk-usage', 'disk-inodes', 'load-average'],
      1000,
      1,
    )
    expect(round.results.map(result => result.checkId)).toEqual(['disk-usage', 'disk-inodes', 'load-average'])
  })

  it('still completes the round when every host is unreachable', async () => {
    const engine = {
      exec: async () => { throw new Error('All configured authentication methods failed') },
    } as unknown as SshEngine
    const round = await makeInspector().run(engine, ['a', 'b', 'c'], ['disk-usage'], 1000, 2)
    // Blind results, not an aborted round: the alert state depends on the
    // round completing.
    expect(round.results).toHaveLength(3)
    expect(round.results.every(result => result.value === null)).toBe(true)
    expect(round.results.every(result => result.breached === false)).toBe(true)
    expect(round.results.every(result => result.error !== undefined)).toBe(true)
  })

  it('handles an empty target list without dividing by zero workers', async () => {
    const fake = makeEngine(() => 1)
    const round = await makeInspector().run(fake.engine, [], ['disk-usage'], 1000)
    expect(round.results).toEqual([])
    expect(round.targets).toEqual([])
  })

  it('clamps a concurrency below one to a single worker', async () => {
    const fake = makeEngine(() => 5)
    const round = await makeInspector().run(fake.engine, ['a', 'b'], ['disk-usage'], 1000, 0)
    expect(fake.peak()).toBe(1)
    expect(round.results.map(result => result.alias)).toEqual(['a', 'b'])
  })
})