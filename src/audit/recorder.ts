/**
 * Audit recording for the fleet tools.
 *
 * The audit log answers "who changed this machine, when, and what did they
 * run". That answer is only complete if EVERY mutating operation is
 * recorded — a log that covers some operations is worse than no log,
 * because the operator trusts the gaps to mean "nothing happened".
 *
 * So the recorder wraps the mutating tools at the point where they are
 * registered, and the read-only tools are deliberately not recorded: an
 * audit log full of `ssh_list` calls buries the entries that matter.
 */

import type { AuditAction, AuditActor, AuditLog, AuditRecord } from './audit-log.ts'

/** The outcome of a tool call, as the recorder sees it. */
export interface CallOutcome {
  /** Whether the call succeeded. */
  ok: boolean
  /** The hosts the call touched. */
  targets?: string[]
  /** A short summary (secrets are redacted on write). */
  summary?: string
  /** Extra structured detail. */
  detail?: Record<string, unknown>
}

/**
 * A recorder bound to one audit log and one actor.
 *
 * The actor matters: an operator running a command from the panel and an
 * agent running the same command are different actors, and an audit trail
 * that cannot tell them apart does not answer "who did this".
 */
export class AuditRecorder {
  /** The log to write to. */
  private readonly log: AuditLog | undefined
  /** Who is performing the actions. */
  private readonly actor: AuditActor

  constructor(log: AuditLog | undefined, actor: AuditActor = 'agent') {
    this.log = log
    this.actor = actor
  }

  /**
   * Record one action.
   *
   * A missing log means auditing is disabled, which is a configuration
   * choice — the call is then a no-op, not an error.
   *
   * @param action - what happened.
   * @param outcome - the outcome of the call.
   */
  record(action: AuditAction, outcome: CallOutcome): void {
    if (this.log === undefined) return
    const record: AuditRecord = {
      ts: Date.now(),
      action,
      actor: this.actor,
      targets: outcome.targets ?? [],
      ok: outcome.ok,
      summary: outcome.summary ?? action,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    }
    this.log.append(record)
  }

  /** Whether this recorder writes anything. */
  get enabled(): boolean {
    return this.log !== undefined
  }
}
