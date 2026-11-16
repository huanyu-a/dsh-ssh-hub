/**
 * Alert rule engine.
 *
 * The state machine here is deliberately conservative, because the failure
 * mode of a monitoring tool is a crying wolf, and a crying wolf gets
 * muted — at which point the tool is worthless.
 *
 * Three rules carry that conservatism:
 *
 * 1. **Consecutive rounds.** A breach must persist for N consecutive
 *    rounds before it fires. One spike is noise; a trend is a problem.
 *    The operator expresses the requirement in seconds ("3 minutes")
 *    and the engine converts it using the poll interval.
 *
 * 2. **null freezes the state.** When a probe cannot read a value (the
 *    host timed out, the command failed), the alert state is FROZEN, not
 *    cleared. A monitoring probe that goes blind must not report
 *    "recovered" — that is how a dead machine ends up looking healthy.
 *
 * 3. **Cooldown blocks re-entry, not recovery.** While an alert is
 *    cooling down, a continued breach does not re-notify. But when the
 *    value comes back under the threshold, the recovery is ALWAYS
 *    notified — an operator who was told "disk full" and never told
 *    "disk fine" still has a page open.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.ts'
import type { CheckResult } from '../inspect/checks.ts'

/** The lifecycle state of one alert. */
export type AlertState =
  /** Healthy: under the threshold. */
  | 'ok'
  /** Breaching, but not yet for long enough to fire. */
  | 'pending'
  /** Breaching and fired. */
  | 'firing'
  /** The value could not be read; the previous state is held. */
  | 'frozen'

/** One alert rule. */
export interface AlertRule {
  /** Stable identifier. */
  id: string
  /** The check this rule watches. */
  checkId: string
  /** Which hosts it covers (empty means every host). */
  hosts?: string[]
  /** How long the breach must persist before it fires, in seconds. */
  forSeconds: number
  /** How long to wait before re-notifying a continued breach, in seconds. */
  cooldownSeconds: number
  /** Whether the rule is active. */
  enabled: boolean
}

/** The persisted state of one (rule, host) pair. */
export interface AlertState_ {
  /** The current state. */
  state: AlertState
  /**
   * The state held across a blackout.
   *
   * While the probe is blind the state is 'frozen'; this keeps the
   * pre-blackout state so the recovery that follows it is still reported.
   */
  heldState?: 'pending' | 'firing'
  /** Consecutive breaching rounds so far. */
  consecutiveBreaches: number
  /** When the current breach streak started (epoch ms). */
  breachStartedAt?: number
  /** When the alert last fired (epoch ms). */
  lastFiredAt?: number
  /** The value that last fired it. */
  lastValue?: number | boolean | string | null
}

/** A notification the engine wants to send. */
export interface AlertNotification {
  /** The rule id. */
  ruleId: string
  /** The host alias. */
  alias: string
  /** 'trigger' for a new breach, 'recover' for a recovery. */
  kind: 'trigger' | 'recover'
  /** The check title. */
  title: string
  /** The value that breached (or returned to normal). */
  value: string
  /** When the event happened. */
  at: number
}

/** The engine's persisted state file. */
export function alertStatePath(): string {
  return join(dshHome(), 'dsh-ssh-hub', 'alerts.json')
}

/**
 * The alert state machine.
 *
 * One instance per plugin apply. The state survives a restart, so an alert
 * that was firing when DSH stopped is still firing when it comes back.
 */
export class AlertEngine {
  /** The state file. */
  readonly path: string
  /** The state, keyed by `ruleId|alias`. */
  private states = new Map<string, AlertState_>()

  constructor(path?: string) {
    this.path = path ?? alertStatePath()
    this.load()
  }

  /**
   * Evaluate one round of inspection results against the rules.
   *
   * @param rules - the rules to apply.
   * @param results - the round's results.
   * @param pollIntervalMs - the poll interval, used to convert the rule's
   * "for" duration into a number of consecutive rounds.
   * @returns the notifications to send.
   */
  evaluate(rules: AlertRule[], results: CheckResult[], pollIntervalMs: number): AlertNotification[] {
    const notifications: AlertNotification[] = []
    const now = Date.now()
    for (const rule of rules) {
      if (!rule.enabled) continue
      const relevant = results.filter(result =>
        result.checkId === rule.checkId
        && (rule.hosts === undefined || rule.hosts.length === 0 || rule.hosts.includes(result.alias)),
      )
      for (const result of relevant) {
        const notification = this.evaluateOne(rule, result, pollIntervalMs, now)
        if (notification !== undefined) notifications.push(notification)
      }
    }
    this.save()
    return notifications
  }

  /**
   * Evaluate one result against one rule.
   *
   * @param rule - the rule.
   * @param result - the check result.
   * @param pollIntervalMs - the poll interval.
   * @param now - the current time.
   * @returns a notification when the state changed in a way that must be
   * reported, otherwise undefined.
   */
  private evaluateOne(
    rule: AlertRule,
    result: CheckResult,
    pollIntervalMs: number,
    now: number,
  ): AlertNotification | undefined {
    const key = `${rule.id}|${result.alias}`
    const previous = this.states.get(key)
    const state: AlertState_ = previous ?? {
      state: 'ok',
      consecutiveBreaches: 0,
    }

    // An unreadable value freezes the state: the previous state is held,
    // and NOTHING is reported. A blind probe must not report a recovery,
    // and must not report a new breach either.
    //
    // The held state is remembered separately: `state` becomes 'frozen' so
    // the operator can see the probe is blind, but the pre-blackout state
    // is kept — otherwise the real recovery that follows the blackout
    // would go unreported and the operator would never learn the machine
    // came back.
    if (result.value === null) {
      if (state.state !== 'frozen' && (state.state === 'firing' || state.state === 'pending')) {
        state.heldState = state.state
      }
      state.state = 'frozen'
      this.states.set(key, state)
      return undefined
    }

    if (!result.breached) {
      // The value is readable and healthy: a recovery, if we were firing.
      // The held state counts: a blackout between the breach and the
      // recovery must not swallow the recovery notification.
      const wasFiring = state.state === 'firing' || state.heldState === 'firing'
      state.state = 'ok'
      state.heldState = undefined
      state.consecutiveBreaches = 0
      state.breachStartedAt = undefined
      state.lastValue = result.value
      this.states.set(key, state)
      // Recovery is ALWAYS reported - the cooldown never suppresses it.
      if (wasFiring) {
        return {
          ruleId: rule.id,
          alias: result.alias,
          kind: 'recover',
          title: result.checkId,
          value: String(result.value),
          at: now,
        }
      }
      // A pending breach that cleared before firing is not an event.
      return undefined
    }

    // The value breaches.
    state.consecutiveBreaches += 1
    if (state.breachStartedAt === undefined) state.breachStartedAt = now
    state.lastValue = result.value

    const requiredRounds = Math.max(1, Math.ceil((rule.forSeconds * 1000) / Math.max(pollIntervalMs, 1)))
    if (state.consecutiveBreaches < requiredRounds) {
      // Still inside the "for" window: pending, not firing.
      state.state = 'pending'
      this.states.set(key, state)
      return undefined
    }

    const wasFiring = state.state === 'firing'
    state.state = 'firing'
    this.states.set(key, state)
    if (wasFiring) {
      // A continued breach: only re-notify after the cooldown.
      const elapsed = state.lastFiredAt === undefined ? Infinity : now - state.lastFiredAt
      if (elapsed < rule.cooldownSeconds * 1000) return undefined
    }
    state.lastFiredAt = now
    return {
      ruleId: rule.id,
      alias: result.alias,
      kind: 'trigger',
      title: result.checkId,
      value: String(result.value),
      at: now,
    }
  }

  /**
   * The current state of every (rule, host) pair.
   *
   * @returns the states.
   */
  list(): Array<{ ruleId: string; alias: string } & AlertState_> {
    const result: Array<{ ruleId: string; alias: string } & AlertState_> = []
    for (const [key, state] of this.states) {
      const [ruleId, alias] = key.split('|')
      if (ruleId === undefined || alias === undefined) continue
      result.push({ ruleId, alias, ...state })
    }
    return result
  }

  /** Load the persisted state. */
  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, AlertState_>
      if (typeof parsed !== 'object' || parsed === null) return
      for (const [key, state] of Object.entries(parsed)) {
        if (typeof state === 'object' && state !== null) this.states.set(key, state)
      }
    } catch {
      // A corrupt state file must not brick the plugin; start clean.
    }
  }

  /** Persist the state. */
  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const plain: Record<string, AlertState_> = {}
    for (const [key, state] of this.states) plain[key] = state
    writeFileSync(this.path, JSON.stringify(plain, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}
