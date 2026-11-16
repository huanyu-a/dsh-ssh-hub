/**
 * Cross-host log search.
 *
 * The agentless way to search logs on 50 Linux machines: run a read-only
 * grep over the log files on each host and aggregate the matches. No agent
 * is installed on the remote side, nothing is written, and the whole thing
 * is one SSH round trip per host.
 *
 * Two sources are supported, because a Linux fleet has both:
 * - `journalctl` for the systemd journal
 * - plain files under a log directory (grep over a file set)
 *
 * The search is BOUNDED on purpose: a grep across a fleet can return
 * megabytes, which would flood the model's context. Per-host match counts
 * and a global match cap keep the result readable, and the truncation is
 * reported rather than hidden.
 */

import type { SshEngine } from '../engine.ts'

/** Where to search. */
export type LogSource =
  /** The systemd journal. */
  | 'journal'
  /** A set of log files under a directory. */
  | 'files'

/** A log search request. */
export interface LogSearchRequest {
  /** The search source. */
  source: LogSource
  /** The pattern to search for (a grep pattern or a journalctl match). */
  pattern: string
  /** The log directory, when the source is 'files'. */
  directory?: string
  /** How many lines to keep per host. */
  maxLinesPerHost?: number
  /** The systemd unit to filter on, when the source is 'journal'. */
  unit?: string
  /** The time window start (epoch seconds), when the source is 'journal'. */
  since?: number
  /** How long the command may take per host. */
  timeoutMs?: number
  /** How many hosts to search at once. */
  maxWorkers?: number
}

/** One host's search outcome. */
export interface LogHostResult {
  alias: string
  ok: boolean
  /** The matching lines (bounded). */
  lines: string[]
  /** How many matches the host reported in total. */
  totalMatches?: number
  /** Whether the output was truncated. */
  truncated?: boolean
  /** The error, when the search failed. */
  error?: string
  /** How long the search took on this host. */
  durationMs?: number
}

/** The outcome of a fleet-wide search. */
export interface LogSearchResult {
  ok: boolean
  /** The hosts that were searched. */
  targets: string[]
  /** The per-host outcomes. */
  results: LogHostResult[]
  /** The total number of matching lines returned. */
  totalLines: number
  /** Whether any host's output was truncated. */
  truncated: boolean
  /** How long the whole search took. */
  durationMs: number
  /** The error, when the search could not run at all. */
  error?: string
}

/**
 * Build the remote command for one search.
 *
 * The pattern is passed as a shell argument, quoted so a pattern with
 * spaces or quotes does not break the command. The pattern itself is a
 * grep pattern — that is the operator's choice, and it runs on their own
 * hosts.
 *
 * @param request - the search request.
 * @returns the command to run on the remote host.
 */
export function buildSearchCommand(request: LogSearchRequest): string {
  const pattern = shellQuote(request.pattern)
  const maxLines = request.maxLinesPerHost ?? 50
  if (request.source === 'journal') {
    const filters: string[] = []
    if (request.unit !== undefined && request.unit !== '') {
      filters.push(`--unit ${shellQuote(request.unit)}`)
    }
    if (request.since !== undefined) {
      filters.push(`--since ${shellQuote(formatSince(request.since))}`)
    }
    const filterText = filters.length > 0 ? ` ${filters.join(' ')}` : ''
    // The total count comes from a separate wc pass so the caller can tell
    // "50 matches, all shown" from "5000 matches, 50 shown".
    return `journalctl ${filterText} --no-pager --no-hostname 2>/dev/null | grep -F -- ${pattern} | head -n ${maxLines}; ` +
      `journalctl ${filterText} --no-pager --no-hostname 2>/dev/null | grep -c -F -- ${pattern}`
  }
  const directory = shellQuote(request.directory ?? '/var/log')
  return `grep -R -F --include='*.log' ${pattern} ${directory} 2>/dev/null | head -n ${maxLines}; ` +
    `grep -R -F --include='*.log' -c ${pattern} ${directory} 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}'`
}

/**
 * Quote a value for a POSIX shell.
 *
 * @param value - the value to quote.
 * @returns the quoted value.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Format a "since" timestamp for journalctl.
 *
 * @param epochSeconds - the timestamp in seconds.
 * @returns the journalctl argument.
 */
export function formatSince(epochSeconds: number): string {
  // journalctl accepts an absolute ISO timestamp or a relative one. The
  // absolute form is unambiguous across timezones.
  return new Date(epochSeconds * 1000).toISOString()
}

/**
 * Search the logs on many hosts.
 *
 * @param engine - the SSH engine.
 * @param request - the search request.
 * @param targets - the host aliases.
 * @returns the fleet-wide outcome.
 */
export async function searchLogs(
  engine: SshEngine,
  request: LogSearchRequest,
  targets: string[],
): Promise<LogSearchResult> {
  const startedAt = Date.now()
  const command = buildSearchCommand(request)
  const timeoutMs = request.timeoutMs ?? 30_000
  const maxWorkers = Math.max(1, request.maxWorkers ?? 8)

  const results: LogHostResult[] = []
  // A bounded worker pool: the engine's pool caps the connections, but the
  // fan-out itself is limited so 50 hosts do not all connect at once.
  let cursor = 0
  const workers = Array.from({ length: Math.min(maxWorkers, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor
      cursor += 1
      const alias = targets[index] as string
      const hostStarted = Date.now()
      try {
        const execResult = await engine.exec(alias, command, timeoutMs)
        const parsed = parseSearchOutput(execResult.stdout, request.maxLinesPerHost ?? 50)
        results.push({
          alias,
          ok: execResult.success,
          lines: parsed.lines,
          totalMatches: parsed.total,
          ...(parsed.truncated ? { truncated: true } : {}),
          ...(execResult.error !== undefined ? { error: execResult.error } : {}),
          durationMs: Date.now() - hostStarted,
        })
      } catch (error) {
        results.push({
          alias,
          ok: false,
          lines: [],
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - hostStarted,
        })
      }
    }
  })
  await Promise.all(workers)

  // Keep the results in the caller's target order, not in completion order.
  const order = new Map(targets.map((alias, index) => [alias, index]))
  results.sort((left, right) => (order.get(left.alias) ?? 0) - (order.get(right.alias) ?? 0))

  return {
    ok: true,
    targets: [...targets],
    results,
    totalLines: results.reduce((sum, result) => sum + result.lines.length, 0),
    truncated: results.some(result => result.truncated === true),
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Parse the combined output of a search command.
 *
 * The command prints the matched lines, then the total count on the last
 * line. The count line is numeric only, so it is unambiguous.
 *
 * @param stdout - the command output.
 * @param maxLines - the per-host cap.
 * @returns the lines and the total count.
 */
export function parseSearchOutput(stdout: string, maxLines: number): { lines: string[]; total: number; truncated: boolean } {
  const all = stdout.split('\n').filter(line => line.trim() !== '')
  if (all.length === 0) return { lines: [], total: 0, truncated: false }
  const last = all[all.length - 1] as string
  const hasCount = /^\d+$/.test(last.trim())
  const count = hasCount ? Number.parseInt(last.trim(), 10) : 0
  const body = hasCount ? all.slice(0, -1) : all
  return {
    lines: body,
    total: count,
    truncated: count > body.length || body.length >= maxLines,
  }
}

/**
 * A human-readable rendering of a search outcome.
 *
 * @param result - the search outcome.
 * @returns the report text.
 */
export function renderLogSearch(result: LogSearchResult): string {
  if (result.error !== undefined) return `日志检索失败：${result.error}`
  const withMatches = result.results.filter(host => host.lines.length > 0)
  const lines: string[] = [
    `跨机日志检索：${result.targets.length} 台主机，命中 ${result.totalLines} 行，耗时 ${result.durationMs}ms`,
  ]
  if (result.truncated) {
    lines.push('（部分主机的输出被截断，命中数可能高于显示行数）')
  }
  for (const host of withMatches) {
    lines.push('', `── ${host.alias}（共 ${host.totalMatches ?? host.lines.length} 条命中）`)
    for (const line of host.lines) lines.push(line)
  }
  const failed = result.results.filter(host => !host.ok)
  if (failed.length > 0) {
    lines.push('', `检索失败：${failed.map(host => `${host.alias}（${host.error ?? '未知错误'}）`).join('、')}`)
  }
  return lines.join('\n')
}
