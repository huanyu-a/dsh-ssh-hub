/**
 * Inspection checks: the vocabulary of what "inspect this fleet" means.
 *
 * The base plugin gives the agent a way to run a command on many hosts at
 * once, but every run is improvised — nothing is defined, nothing is
 * retained, nothing can be compared against last time. That is fine for
 * "what is on this box" and useless for "is the fleet healthy".
 *
 * A check here is a named, typed probe with a command, a parser and a
 * verdict rule. Checks are defined in code (they are part of the product,
 * not user data), so their commands are known-good POSIX shell — the fleet
 * is Linux-only by design, and the probes read only.
 */

import type { ExecResult } from '../protocol.ts'

/** How a check's value is judged. */
export type CheckKind =
  /** A percentage 0-100; the threshold is a watermark. */
  | 'percent'
  /** A number compared against a threshold. */
  | 'gauge'
  /** A boolean: does the thing exist / is it running. */
  | 'boolean'
  /** A free-form text value (a version, a mount path). */
  | 'text'

/** Which way a breach is judged. */
export type CheckDirection =
  /** High values are bad (disk usage). */
  | 'above'
  /** Low values are bad (free space, free memory). */
  | 'below'

/** One inspection check. */
export interface Check {
  /** Stable identifier, used in stored results. */
  id: string
  /** What the check measures, in the operator's language. */
  title: string
  /** How the value is judged. */
  kind: CheckKind
  /** Which way a breach goes. */
  direction: CheckDirection
  /**
   * The breach threshold: a percentage for 'percent', a number for
   * 'gauge', unused for the other kinds.
   */
  threshold?: number
  /** The read-only command that produces the value. */
  command: string
  /** Parse the command output into a value. */
  parse: (stdout: string) => number | boolean | string | null
  /** The unit shown in the panel. */
  unit?: string
}

/** The outcome of one check on one host. */
export interface CheckResult {
  /** The check id. */
  checkId: string
  /** The host alias. */
  alias: string
  /** The parsed value, or null when the probe could not produce one. */
  value: number | boolean | string | null
  /** Whether the value breaches the threshold. */
  breached: boolean
  /** The raw output, trimmed, for the operator to read. */
  raw: string
  /** The error when the command itself failed. */
  error?: string
}

/**
 * The built-in check set.
 *
 * Every command is read-only and POSIX-shell compatible. Nothing installs
 * anything on the remote host and nothing writes to it — an inspection
 * that mutates the fleet is not an inspection.
 */
export const BUILTIN_CHECKS: readonly Check[] = [
  {
    id: 'disk-usage',
    title: '磁盘使用率',
    kind: 'percent',
    direction: 'above',
    threshold: 85,
    unit: '%',
    // df -P keeps the output POSIX (one line per filesystem, no wrapping).
    command: 'df -P / | tail -1 | awk \'{print $5}\' | tr -d "%"',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'load-average',
    title: '负载（5 分钟）',
    kind: 'gauge',
    direction: 'above',
    threshold: 4,
    command: 'cat /proc/loadavg | awk \'{print $2}\'',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'memory-used',
    title: '内存使用率',
    kind: 'percent',
    direction: 'above',
    threshold: 90,
    unit: '%',
    // /proc/meminfo is the only source that needs no external tool.
    command: 'awk \'/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {if (t>0) printf "%d", (t-a)*100/t}\' /proc/meminfo',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'disk-inodes',
    title: 'inode 使用率',
    kind: 'percent',
    direction: 'above',
    threshold: 85,
    unit: '%',
    command: 'df -Pi / | tail -1 | awk \'{print $5}\' | tr -d "%"',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'uptime',
    title: '运行时长',
    kind: 'gauge',
    direction: 'below',
    // A server that rebooted within an hour is usually rebooting in a loop.
    threshold: 3600,
    unit: '秒',
    command: 'cat /proc/uptime | awk \'{print int($1)}\'',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'sshd-running',
    title: 'sshd 运行中',
    kind: 'boolean',
    direction: 'above',
    command: 'pgrep -x sshd >/dev/null 2>&1 && echo running || echo stopped',
    parse: stdout => stdout.includes('running'),
  },
  {
    id: 'failed-units',
    title: '失败的 systemd 单元',
    kind: 'gauge',
    direction: 'above',
    threshold: 0,
    command: 'systemctl list-units --state=failed --no-legend --no-pager 2>/dev/null | wc -l',
    parse: stdout => parseNumber(stdout),
  },
  {
    id: 'kernel',
    title: '内核版本',
    kind: 'text',
    direction: 'above',
    command: 'uname -r',
    parse: stdout => stdout.trim() === '' ? null : stdout.trim(),
  },
]

/**
 * Parse a number out of command output.
 *
 * @param stdout - the raw output.
 * @returns the first number found, or null.
 */
export function parseNumber(stdout: string): number | null {
  const match = stdout.match(/-?\d+(?:\.\d+)?/)
  if (match === null) return null
  const value = Number.parseFloat(match[0])
  return Number.isFinite(value) ? value : null
}

/**
 * Find a check by id.
 *
 * @param id - the check id.
 * @returns the check, or undefined.
 */
export function findCheck(id: string): Check | undefined {
  return BUILTIN_CHECKS.find(check => check.id === id)
}

/**
 * Judge one parsed value against a check's threshold.
 *
 * A `null` value never breaches: an unreadable probe is an unknown state,
 * not a healthy one and not a breach either. The caller records the
 * distinction — an unknown value must not be silently counted as healthy.
 *
 * @param check - the check.
 * @param value - the parsed value.
 * @returns whether the value breaches.
 */
export function isBreached(check: Check, value: number | boolean | string | null): boolean {
  if (value === null) return false
  if (check.kind === 'boolean') {
    // For a boolean, "running" is the good state; the direction says which
    // way is bad, so 'above' means "false is bad".
    const asBoolean = value === true || value === 'running' || value === 'true'
    return check.direction === 'above' ? !asBoolean : asBoolean
  }
  if (check.kind === 'text') return false
  if (typeof value !== 'number' || check.threshold === undefined) return false
  return check.direction === 'above' ? value > check.threshold : value < check.threshold
}

/**
 * Turn one exec result into a check result.
 *
 * @param check - the check that was run.
 * @param alias - the host alias.
 * @param result - the exec result.
 * @returns the check result.
 */
export function toCheckResult(check: Check, alias: string, result: ExecResult): CheckResult {
  if (result.error !== undefined || !result.success) {
    return {
      checkId: check.id,
      alias,
      value: null,
      breached: false,
      raw: result.stderr.trim().slice(0, 2000),
      error: result.error ?? `command failed with exit code ${result.exitCode ?? 'null'}`,
    }
  }
  const raw = result.stdout.trim()
  const value = check.parse(raw)
  return {
    checkId: check.id,
    alias,
    value,
    breached: isBreached(check, value),
    raw: raw.slice(0, 2000),
  }
}

/**
 * A human-readable rendering of one value.
 *
 * @param check - the check the value belongs to.
 * @param value - the parsed value.
 * @returns the display text.
 */
export function formatValue(check: Check, value: number | boolean | string | null): string {
  if (value === null) return '未知'
  if (typeof value === 'boolean') return value ? '正常' : '异常'
  if (typeof value === 'string') return value
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1)
  return check.unit === undefined ? rounded : `${rounded}${check.unit}`
}
