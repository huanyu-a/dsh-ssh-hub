/**
 * Inspection runner and result retention.
 *
 * Runs the built-in checks across a selected set of hosts (reusing the
 * engine's pool, so no extra connections are opened), stores each round as
 * a JSON Lines record, and answers "what changed since last time".
 *
 * The comparison is the point: a raw dump of "disk 71%" says nothing, while
 * "disk 71% (was 42% an hour ago)" says the fleet is filling up. Every round
 * is therefore retained, and the diff is computed from the two newest
 * rounds by default.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.ts'
import type { SshEngine } from '../engine.ts'
import type { ExecResult } from '../protocol.ts'
import {
  BUILTIN_CHECKS,
  type Check,
  type CheckResult,
  formatValue,
  toCheckResult,
} from './checks.ts'

/** One inspection round. */
export interface InspectionRound {
  /** Epoch milliseconds when the round started. */
  startedAt: number
  /** How long the round took. */
  durationMs: number
  /** The hosts covered. */
  targets: string[]
  /** Every check result, flattened. */
  results: CheckResult[]
}

/** One host's change between two rounds. */
export interface HostChange {
  alias: string
  checkId: string
  title: string
  /** The previous display value, or undefined when the check is new. */
  before?: string
  /** The current display value. */
  after: string
  /** Whether the breach state changed (and in which direction). */
  stateChange?: 'new-breach' | 'recovered'
}

/** The inspection history file. */
export function historyPath(): string {
  return join(dshHome(), 'dsh-ssh-hub', 'inspection.jsonl')
}

/**
 * The inspection runner.
 *
 * One instance per plugin apply. Holds no long-lived state beyond the file
 * path: rounds are written as they complete, so a crash loses at most the
 * round in flight.
 */
export class Inspector {
  /** The history file this inspector appends to. */
  readonly path: string
  /** How many rounds to keep for comparison and display. */
  readonly maxRounds: number

  constructor(path?: string, maxRounds = 100) {
    this.path = path ?? historyPath()
    this.maxRounds = maxRounds
  }

  /**
   * Run one round of checks.
   *
   * @param engine - the SSH engine (the connection pool is reused).
   * @param targets - the host aliases to inspect.
   * @param checkIds - which checks to run (default: all built-in checks).
   * @param timeoutMs - per-command timeout.
   * @returns the completed round.
   */
  async run(
    engine: SshEngine,
    targets: string[],
    checkIds?: string[],
    timeoutMs = 30_000,
  ): Promise<InspectionRound> {
    const startedAt = Date.now()
    const checks = selectChecks(checkIds)
    // Each (host, check) pair is one command. The engine's own pool keeps
    // the connection count bounded, and the cluster helper fans out.
    const results: CheckResult[] = []
    for (const alias of targets) {
      for (const check of checks) {
        // One unreachable host must not abort the round.
        //
        // An inspection runs on a timer against a whole fleet, and a fleet
        // always contains at least one machine that is rebooting, firewalled
        // or powered off. Letting engine.exec's rejection escape here would
        // take down the entire round — and, since the round is what advances
        // the alert state, the whole monitoring loop with it. The failure is
        // recorded as a blind result (value null) against this one check, so
        // it shows up as "we could not see" rather than as "the fleet is
        // fine", which is what a missing row would have implied.
        try {
          const execResult = await engine.exec(alias, check.command, timeoutMs)
          results.push(toResult(check, alias, execResult))
        } catch (error) {
          results.push({
            checkId: check.id,
            alias,
            value: null,
            breached: false,
            raw: '',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    const round: InspectionRound = {
      startedAt,
      durationMs: Date.now() - startedAt,
      targets: [...targets],
      results,
    }
    this.append(round)
    return round
  }

  /**
   * Append one round to the history file.
   *
   * @param round - the round to store.
   */
  append(round: InspectionRound): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(this.path, JSON.stringify(round) + '\n', { encoding: 'utf8', mode: 0o600 })
    // Notify the observer after the round is durable: a subscriber that
    // needs the history (the metric store) must not see a round that a
    // failed write left out of the file.
    try {
      this.onRound?.(round)
    } catch {
      // An observer failure is not an inspection failure. Swallowing it
      // here keeps the round valid for everyone else.
    }
  }

  /**
   * Called after every round is durably appended.
   *
   * Used by the metric store to derive series from rounds, so the tiers stay
   * current whether the round came from the timer or from a tool call.
   */
  onRound?: (round: InspectionRound) => void

  /**
   * Read the most recent rounds, oldest first.
   *
   * @param limit - how many rounds to return.
   * @returns the rounds.
   */
  read(limit = 20): InspectionRound[] {
    if (!existsSync(this.path)) return []
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const rounds: InspectionRound[] = []
    for (const line of lines.slice(-limit)) {
      try {
        rounds.push(JSON.parse(line) as InspectionRound)
      } catch {
        // A truncated line (a crash mid-write) must not hide the rest.
      }
    }
    return rounds
  }

  /**
   * Compare the two newest rounds.
   *
   * @returns the changes, newest round against the one before it. An empty
   * array means either fewer than two rounds exist or nothing changed — the
   * caller distinguishes the two by looking at {@link read}.
   */
  diff(): HostChange[] {
    const rounds = this.read(2)
    if (rounds.length < 2) return []
    const [previous, current] = rounds as [InspectionRound, InspectionRound]
    const before = indexResults(previous)
    const changes: HostChange[] = []
    for (const result of current.results) {
      const check = checkOf(result.checkId)
      const key = `${result.alias}\u0000${result.checkId}`
      const prior = before.get(key)
      const after = formatValue(check, result.value)
      if (prior === undefined) {
        // A host or check that was not in the previous round: report it as
        // new rather than pretending the value appeared unchanged.
        changes.push({ alias: result.alias, checkId: result.checkId, title: check.title, after })
        continue
      }
      const beforeText = formatValue(check, prior.value)
      const stateChange = prior.breached === result.breached
        ? undefined
        : result.breached ? 'new-breach' as const : 'recovered' as const
      if (beforeText === after && stateChange === undefined) continue
      changes.push({
        alias: result.alias,
        checkId: result.checkId,
        title: check.title,
        before: beforeText,
        after,
        ...(stateChange !== undefined ? { stateChange } : {}),
      })
    }
    return changes
  }
}

/**
 * The checks selected by the given ids.
 *
 * An unknown id throws: silently skipping it would let a typo look like a
 * clean inspection.
 *
 * @param checkIds - the requested ids, or undefined for all.
 * @returns the checks to run.
 */
export function selectChecks(checkIds?: string[]): readonly Check[] {
  if (checkIds === undefined || checkIds.length === 0) return BUILTIN_CHECKS
  const selected: Check[] = []
  for (const id of checkIds) {
    const check = BUILTIN_CHECKS.find(candidate => candidate.id === id)
    if (check === undefined) {
      throw new Error(`unknown check '${id}' — available: ${BUILTIN_CHECKS.map(candidate => candidate.id).join(', ')}`)
    }
    selected.push(check)
  }
  return selected
}

/** Index a round's results by host+check for lookup. */
function indexResults(round: InspectionRound): Map<string, CheckResult> {
  const map = new Map<string, CheckResult>()
  for (const result of round.results) {
    map.set(`${result.alias}\u0000${result.checkId}`, result)
  }
  return map
}

/** The check a stored result belongs to (falls back to a stub for a removed check). */
function checkOf(checkId: string): Check {
  const found = BUILTIN_CHECKS.find(candidate => candidate.id === checkId)
  if (found !== undefined) return found
  // A check id that no longer exists (a check was renamed or removed):
  // keep the stored value readable instead of throwing.
  return {
    id: checkId,
    title: checkId,
    kind: 'text',
    direction: 'above',
    command: '',
    parse: () => null,
  }
}

/** Project one exec result onto a stored check result. */
function toResult(check: Check, alias: string, result: ExecResult): CheckResult {
  return toCheckResult(check, alias, result)
}
