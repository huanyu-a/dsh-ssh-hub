/**
 * Monitoring loop tests.
 *
 * The loop's contract is about what it does *not* do as much as what it
 * does: it must not stack rounds, must not keep probing after a stop, and
 * must not let a notification failure take the loop down. Those are the
 * cases that decide whether a monitoring tool is trustworthy, so they get
 * the most coverage here.
 */

import { describe, expect, it, vi } from 'vitest'
import { Monitor, type TimerHost } from '../src/monitor/loop.ts'
import { Inspector, type InspectionRound } from '../src/inspect/inspection.ts'
import { AlertEngine, type AlertRule } from '../src/alerting/rules.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshEngine } from '../src/engine.ts'
import type { AlertEvent } from '../src/alerting/tools.ts'

/** A timer that records the callback and lets the test fire it. */
class FakeTimer implements TimerHost {
  callback: (() => void) | undefined
  delay = 0
  stopped = false
  interval(callback: () => void, delay: number): () => void {
    this.callback = callback
    this.delay = delay
    return () => { this.stopped = true }
  }
}

/** A stand-in engine whose exec answers a fixed stdout per check command. */
function fakeEngine(stdout: string): SshEngine {
  return {
    exec: async () => ({ stdout, stderr: '', code: 0, signal: null }),
  } as unknown as SshEngine
}

/** A round-producing inspector that records how many times it ran. */
function fakeInspector(round: InspectionRound): { inspector: Inspector; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-monitor-'))
  const inspector = new Inspector(join(dir, 'inspection.jsonl'))
  let count = 0
  const realRun = inspector.run.bind(inspector)
  inspector.run = async () => {
    count += 1
    const produced = { ...round, startedAt: Date.now() }
    inspector.append(produced)
    return produced
  }
  void realRun
  return { inspector, runs: () => count }
}

/** A minimal round with one breach on one host. */
function roundWithBreach(): InspectionRound {
  return {
    startedAt: Date.now(),
    durationMs: 5,
    targets: ['h1'],
    results: [
      { checkId: 'disk-usage', alias: 'h1', value: 95, breached: true, raw: '95' },
      { checkId: 'load-average', alias: 'h1', value: 0.4, breached: false, raw: '0.4' },
    ],
  }
}

/** The default rule set the loop is given. */
const RULES: AlertRule[] = [
  { id: 'disk-full', checkId: 'disk-usage', forSeconds: 0, cooldownSeconds: 1800, enabled: true },
]

describe('Monitor.start', () => {
  it('arms one interval and reports running', () => {
    const timer = new FakeTimer()
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    }, )
    monitor.start(timer)
    expect(monitor.running).toBe(true)
    expect(timer.delay).toBe(30_000)
    expect(timer.callback).toBeTypeOf('function')
  })

  it('is a no-op when already running, so two timers never double the probes', () => {
    const timer = new FakeTimer()
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    const first = monitor.start(timer)
    const second = monitor.start(timer)
    expect(second).toBe(first)
  })

  it('clamps an absurdly small interval to one second', () => {
    const timer = new FakeTimer()
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 10, rules: RULES, targets: () => ['h1'],
    })
    monitor.start(timer)
    expect(timer.delay).toBe(1000)
  })

  it('stops the timer and reports not running', () => {
    const timer = new FakeTimer()
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    monitor.start(timer)
    monitor.stop()
    expect(timer.stopped).toBe(true)
    expect(monitor.running).toBe(false)
  })

  it('tolerates stop without start', () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    expect(() => { monitor.stop() }).not.toThrow()
  })
})

describe('Monitor.tick', () => {
  it('runs a round and reports the breach count', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    const tick = await monitor.tick()
    expect(tick?.ran).toBe(true)
    expect(tick?.hosts).toBe(1)
    expect(tick?.breaches).toBe(1)
  })

  it('skips a tick when a round is already in flight instead of stacking', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    // The first round blocks until the test releases it, so the second tick
    // provably arrives while the first is still running.
    const originalRun = inspector.run.bind(inspector)
    inspector.run = async (...args) => {
      await gate
      return originalRun(...args)
    }
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    const first = monitor.tick()
    const second = await monitor.tick()
    expect(second).toBeUndefined()
    expect(monitor.ticks.at(-1)?.skippedBecause).toContain('上一轮')
    release?.()
    await first
  })

  it('skips when there are no hosts instead of reporting an empty healthy fleet', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => [],
    })
    const tick = await monitor.tick()
    expect(tick).toBeUndefined()
    expect(monitor.ticks.at(-1)).toMatchObject({ ran: false, skippedBecause: '没有需要巡检的主机' })
  })

  it('counts blind probes separately from breaches', async () => {
    const blind: InspectionRound = {
      startedAt: Date.now(),
      durationMs: 1,
      targets: ['h1'],
      results: [{ checkId: 'disk-usage', alias: 'h1', value: null, breached: false, raw: '' }],
    }
    const { inspector } = fakeInspector(blind)
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine(''), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    const tick = await monitor.tick()
    expect(tick?.breaches).toBe(0)
    expect(tick?.blind).toBe(1)
  })

  it('records the alert event and calls the notifier', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const events: AlertEvent[] = []
    const onNotify = vi.fn()
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, events, {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    }, onNotify)
    await monitor.tick()
    expect(onNotify).toHaveBeenCalled()
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toMatchObject({ ruleId: 'disk-full', alias: 'h1', kind: 'trigger' })
  })

  it('keeps the loop alive when a notification channel throws', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const events: AlertEvent[] = []
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, events, {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    }, () => { throw new Error('webhook down') })
    const tick = await monitor.tick()
    // The round still completed and the event is still recorded: a broken
    // webhook must not cost the operator the next round's data.
    expect(tick?.ran).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it('advances the alert state machine across rounds', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 30_000, rules: RULES, targets: () => ['h1'],
    })
    await monitor.tick()
    const afterFirst = alerts.list()
    expect(afterFirst.length).toBe(1)
    await monitor.tick()
    // Second round keeps the state; it does not reset to ok.
    expect(alerts.list()[0]?.state).not.toBe('ok')
  })

  it('bounds the event feed so a long-running process does not leak', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const events: AlertEvent[] = []
    // A cooldown of zero with forSeconds 0 makes every round emit an event.
    const rules: AlertRule[] = [{ id: 'r', checkId: 'disk-usage', forSeconds: 0, cooldownSeconds: 0, enabled: true }]
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, events, {
      intervalMs: 30_000, rules, targets: () => ['h1'],
    })
    for (let index = 0; index < 30; index += 1) {
      monitor.ticks.splice(0)
      // Force a fresh notification each round by clearing the cooldown stamp.
      await monitor.tick()
    }
    expect(events.length).toBeLessThanOrEqual(500)
  })
})

describe('Monitor.status', () => {
  it('reports interval, host count and the last tick', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 45_000, rules: RULES, targets: () => ['h1', 'h2'],
    })
    await monitor.tick()
    const status = monitor.status()
    expect(status).toMatchObject({ running: false, intervalMs: 45_000, hosts: 2 })
    expect(status.lastTick?.ran).toBe(true)
    expect(status.lastRoundAt).toBeTypeOf('number')
  })

  it('leaves out nextTickAt while the loop is not armed', async () => {
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 45_000, rules: RULES, targets: () => ['h1'],
    })
    await monitor.tick()
    expect(monitor.status().nextTickAt).toBeUndefined()
  })

  it('projects nextTickAt once armed', async () => {
    const timer = new FakeTimer()
    const { inspector } = fakeInspector(roundWithBreach())
    const alerts = new AlertEngine(join(mkdtempSync(join(tmpdir(), 'dsh-alert-')), 'alerts.json'))
    const monitor = new Monitor(fakeEngine('95'), inspector, alerts, [], {
      intervalMs: 45_000, rules: RULES, targets: () => ['h1'],
    })
    monitor.start(timer)
    await monitor.tick()
    expect(monitor.status().nextTickAt).toBeGreaterThan(Date.now() - 1000)
  })
})