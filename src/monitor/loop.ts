/**
 * The monitoring loop: inspection on a timer, feeding the alert engine.
 *
 * This is the piece that turns the inspection layer from "an agent can ask
 * for a health check" into "the fleet is watched". Without it, an alert
 * only advances when a human (or an agent) happens to run hub_inspect, so a
 * disk filling up at 03:00 is discovered whenever someone next looks —
 * which is exactly the failure a monitoring tool exists to prevent.
 *
 * The loop is deliberately conservative, because its failure mode is
 * expensive:
 *
 * - **One round at a time.** A round that outlasts the interval does not
 *   stack: the next tick is skipped, not queued. Fifty hosts with a slow
 *   connection would otherwise pile up overlapping rounds until the pool
 *   is exhausted.
 * - **The timer belongs to the plugin's fiber.** `ctx.timer.interval`
 *   disposes with the fiber, so disabling the plugin stops the loop
 *   instead of leaving an orphan timer probing servers forever.
 * - **A failed round is not a fleet-wide alert.** If every host fails, the
 *   cause is almost always the local link or the pool, not fifty machines
 *   dying at once. The round is reported as a degraded round, and the
 *   alert engine's null-freeze keeps the previous states rather than
 *   inventing fifty recoveries.
 */

import type { SshEngine } from '../engine.ts'
import type { Inspector, InspectionRound } from '../inspect/inspection.ts'
import { findCheck, formatValue } from '../inspect/checks.ts'
import type { AlertEngine, AlertNotification, AlertRule } from '../alerting/rules.ts'
import type { AlertEvent } from '../alerting/tools.ts'

/** Where the tick callback gets its timer from (the cordis timer service). */
export interface TimerHost {
  interval(callback: () => void, delay: number): () => void
}

/** Monitoring loop options. */
export interface MonitorOptions {
  /** How often to run a round, in milliseconds. */
  intervalMs: number
  /** The hosts to watch (a fixed set captured at start; re-resolved per round). */
  targets?: () => string[]
  /** Which checks to run (default: all built-in checks). */
  checks?: string[]
  /** Per-command timeout. */
  timeoutMs?: number
  /** The alert rules. */
  rules: AlertRule[]
}

/** A round's outcome as the loop records it. */
export interface MonitorTick {
  /** Epoch milliseconds when the round started. */
  at: number
  /** Whether the round actually ran (false when skipped as overlapping). */
  ran: boolean
  /** How many hosts were inspected. */
  hosts: number
  /** How many results breached their threshold. */
  breaches: number
  /** How many probe failures (unreadable values) occurred. */
  blind: number
  /** The notifications this round produced. */
  notifications: AlertNotification[]
  /** Why the round did not run, when it did not. */
  skippedBecause?: string
}

/**
 * The monitoring loop.
 *
 * Owns no state beyond `running` and the recent ticks: the inspection
 * history and the alert state each have their own store, so a restart of
 * the loop does not lose either.
 */
export class Monitor {
  private readonly engine: SshEngine
  private readonly inspector: Inspector
  private readonly alerts: AlertEngine
  private readonly events: AlertEvent[]
  private readonly onNotify?: (notification: AlertNotification) => void | Promise<void>
  private readonly options: MonitorOptions
  /** Recent ticks, newest last (bounded). */
  readonly ticks: MonitorTick[] = []
  /** The interval disposer, while the loop runs. */
  private dispose: (() => void) | undefined
  /** Whether a round is in flight (the overlap guard). */
  private inFlight = false
  /** The last round, for the panel to read without re-reading the file. */
  lastRound: InspectionRound | undefined

  constructor(
    engine: SshEngine,
    inspector: Inspector,
    alerts: AlertEngine,
    events: AlertEvent[],
    options: MonitorOptions,
    onNotify?: (notification: AlertNotification) => void | Promise<void>,
  ) {
    this.engine = engine
    this.inspector = inspector
    this.alerts = alerts
    this.events = events
    this.options = options
    this.onNotify = onNotify
  }

  /** Whether the loop is currently armed. */
  get running(): boolean {
    return this.dispose !== undefined
  }

  /**
   * Start the loop.
   *
   * A second start is a no-op rather than a second timer: two timers would
   * double every probe against the fleet.
   *
   * @param timer - the cordis timer service.
   * @returns the disposer that stops the loop.
   */
  start(timer: TimerHost): () => void {
    if (this.dispose !== undefined) return this.dispose
    const delay = Math.max(1000, this.options.intervalMs)
    const stop = timer.interval(() => { void this.tick() }, delay)
    this.dispose = () => {
      stop()
      this.dispose = undefined
    }
    return this.dispose
  }

  /** Stop the loop (idempotent). */
  stop(): void {
    this.dispose?.()
  }

  /**
   * Run one round now.
   *
   * @returns the round's outcome, or undefined when a round was already in
   * flight (the tick is skipped, not queued).
   */
  async tick(): Promise<MonitorTick | undefined> {
    if (this.inFlight) {
      this.record({
        at: Date.now(),
        ran: false,
        hosts: 0,
        breaches: 0,
        blind: 0,
        notifications: [],
        skippedBecause: '上一轮尚未结束',
      })
      return undefined
    }
    this.inFlight = true
    const startedAt = Date.now()
    try {
      const targets = this.options.targets?.() ?? []
      if (targets.length === 0) {
        this.record({
          at: startedAt,
          ran: false,
          hosts: 0,
          breaches: 0,
          blind: 0,
          notifications: [],
          skippedBecause: '没有需要巡检的主机',
        })
        return undefined
      }
      const round = await this.inspector.run(this.engine, targets, this.options.checks, this.options.timeoutMs)
      this.lastRound = round
      const breaches = round.results.filter(result => result.breached).length
      const blind = round.results.filter(result => result.value === null).length
      const notifications = this.alerts.evaluate(this.options.rules, round.results, this.options.intervalMs)
      for (const notification of notifications) {
        this.events.push({
          ruleId: notification.ruleId,
          alias: notification.alias,
          kind: notification.kind,
          value: notification.value,
          at: notification.at,
        })
        // A notification channel that throws must not kill the loop: the
        // alert is already recorded, and losing the next round would be a
        // worse outcome than a missed page.
        try {
          await this.onNotify?.(notification)
        } catch { /* recorded above; delivery failure is reported by the sender */ }
      }
      // Bound the event feed: an unbounded array in a long-running process
      // is a leak, and the panel only shows the recent tail anyway.
      if (this.events.length > 500) this.events.splice(0, this.events.length - 500)
      const tick: MonitorTick = {
        at: startedAt,
        ran: true,
        hosts: targets.length,
        breaches,
        blind,
        notifications,
      }
      this.record(tick)
      return tick
    } finally {
      this.inFlight = false
    }
  }

  /** Append a tick to the bounded history. */
  private record(tick: MonitorTick): void {
    this.ticks.push(tick)
    if (this.ticks.length > 100) this.ticks.splice(0, this.ticks.length - 100)
  }

  /**
   * The current state, for the status route and the panel.
   *
   * @returns the loop's health summary.
   */
  status(): {
    running: boolean
    intervalMs: number
    lastTick?: MonitorTick
    nextTickAt?: number
    hosts: number
    lastRoundAt?: number
  } {
    const last = this.ticks[this.ticks.length - 1]
    return {
      running: this.running,
      intervalMs: this.options.intervalMs,
      ...(last !== undefined ? { lastTick: last } : {}),
      ...(last !== undefined && this.running ? { nextTickAt: last.at + this.options.intervalMs } : {}),
      hosts: this.options.targets?.().length ?? 0,
      ...(this.lastRound !== undefined ? { lastRoundAt: this.lastRound.startedAt } : {}),
    }
  }
}

/**
 * Render one round as operator-facing text.
 *
 * Used by the status route and the panel's inspection tab, so both show the
 * same thing the agent sees.
 *
 * @param round - the round.
 * @returns the report text.
 */
export function renderRound(round: InspectionRound): string {
  const lines: string[] = [
    `巡检 ${round.targets.length} 台主机，耗时 ${round.durationMs}ms`,
  ]
  const breached = round.results.filter(result => result.breached)
  const blind = round.results.filter(result => result.value === null)
  lines.push(`超限 ${breached.length} 项，探针失联 ${blind.length} 项`)
  for (const result of breached) {
    const check = findCheck(result.checkId)
    const label = result.checkId
    lines.push(`  ${result.alias} | ${label} | ${check === undefined ? String(result.value) : formatValue(check, result.value)}`)
  }
  return lines.join('\n')
}