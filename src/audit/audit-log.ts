/**
 * Operation audit log.
 *
 * Every consequential action (exec, cluster, transfer, tunnel, deploy,
 * credential change) is recorded: what happened, against which hosts, with
 * which outcome, and who triggered it.
 *
 * The log is append-only JSON Lines — one record per line — so it can be
 * tailed, grepped and shipped without a database. It lives beside the
 * host store under `$DSH_HOME`, owner-readable only.
 *
 * Two rules the log must never break:
 * 1. No secret ever reaches it. Commands are recorded, but a command that
 *    embeds a password is redacted before it is written.
 * 2. A record is written AFTER the outcome is known, so the log says what
 *    happened rather than what was attempted.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.ts'

/** What kind of action was performed. */
export type AuditAction =
  | 'host.create'
  | 'host.update'
  | 'host.delete'
  | 'host.test'
  | 'exec'
  | 'cluster'
  | 'upload'
  | 'download'
  | 'tunnel.start'
  | 'tunnel.stop'
  | 'tunnel.update'
  | 'deploy'
  | 'rollback'
  | 'inspect.run'
  | 'credential.rotate'
  | 'security.policy'

/** How the action was triggered. */
export type AuditActor = 'user' | 'agent' | 'system'

/** One audit record. */
export interface AuditRecord {
  /** Epoch milliseconds. */
  ts: number
  /** What happened. */
  action: AuditAction
  /** Who triggered it. */
  actor: AuditActor
  /** The hosts the action touched. */
  targets: string[]
  /** Whether it succeeded. */
  ok: boolean
  /** A short, human-readable summary (never contains secrets). */
  summary: string
  /** Free-form details: exit codes, durations, counts. */
  detail?: Record<string, unknown>
}

/** The audit log file path. */
export function auditLogPath(): string {
  return join(dshHome(), 'dsh-ssh-hub', 'audit.log')
}

/**
 * Patterns whose match must never be written to the log.
 *
 * These are the shapes a password takes in a shell command line — the
 * only place a secret is likely to appear in an audit record.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // `password=secret`, `PASSWORD: secret`, `passwd=secret`
  [/\b(pass(?:word|wd|phrase)?)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]'],
  // `-p secret` / `--password secret` (mysql, psql style)
  [/(--password[= ])(("[^"]*"|'[^']*'|\S+))/g, '$1[REDACTED]'],
  // `echo secret | sudo -S`
  [/(echo\s+)("[^"]*"|'[^']*'|\S+)(\s*\|\s*(sudo\s+-S|-S))/g, '$1[REDACTED]$3'],
  // `Authorization: Bearer <token>`
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, '$1[REDACTED]'],
  // A private key block pasted into a command.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
]

/**
 * Redact secrets from a string before it is recorded.
 *
 * @param text - the text to redact.
 * @returns the redacted text.
 */
export function redact(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * The audit log writer.
 *
 * Writes are best-effort: a failure to audit must not fail the operation
 * the user asked for (an unwritable log directory should not block a
 * deployment), but the failure is reported so it is not silent.
 */
export class AuditLog {
  /** The file this log writes to. */
  readonly path: string
  /** The last write error, if any. */
  lastError: string | undefined

  constructor(path?: string) {
    this.path = path ?? auditLogPath()
  }

  /**
   * Append one record.
   *
   * @param record - the record to write.
   */
  append(record: AuditRecord): void {
    const line = JSON.stringify({
      ...record,
      summary: redact(record.summary),
      detail: record.detail === undefined ? undefined : redactDetail(record.detail),
    }) + '\n'
    try {
      const dir = dirname(this.path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(this.path, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Read the most recent records, newest last.
   *
   * @param limit - the maximum number of records to return.
   * @returns the records, oldest first.
   */
  read(limit = 100): AuditRecord[] {
    if (!existsSync(this.path)) return []
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const slice = lines.slice(-limit)
    const records: AuditRecord[] = []
    for (const line of slice) {
      try {
        records.push(JSON.parse(line) as AuditRecord)
      } catch {
        // A partially written line must not break the whole read.
      }
    }
    return records
  }
}

/**
 * Redact secrets inside a detail object, recursively.
 *
 * @param detail - the detail object.
 * @returns the redacted detail.
 */
function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string') {
      result[key] = redact(value)
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => typeof item === 'string' ? redact(item) : item)
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactDetail(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * A short, stable summary of an exec/cluster outcome.
 *
 * @param alias - the host alias.
 * @param command - the command (redacted by the writer).
 * @param exitCode - the remote exit code.
 * @param durationMs - how long it took.
 * @returns the summary text.
 */
export function execSummary(alias: string, command: string, exitCode: number | null, durationMs: number): string {
  return `${alias}: ${command} -> exit ${exitCode ?? 'null'} in ${durationMs}ms`
}
