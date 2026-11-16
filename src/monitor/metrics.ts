/**
 * Metric sampling and tiered retention.
 *
 * A fleet operator needs two different things from history, and they pull in
 * opposite directions:
 *
 * - **"What happened at 03:12?"** wants fine resolution, recently.
 * - **"Is this box slowly filling up over months?"** wants a long window,
 *   and does not care about per-second detail.
 *
 * Keeping every raw sample forever answers both and costs unbounded disk on
 * the operator's own workstation. Keeping only hourly averages answers the
 * second and makes the first unanswerable. So this keeps three tiers and
 * lets the coarse tiers outlive the fine ones:
 *
 *     raw    one sample per round, pruned after RAW_WINDOW
 *     1m     one sample per minute,  pruned after MINUTE_WINDOW
 *     15m    one sample per 15 min,  pruned after QUARTER_WINDOW
 *     1h     one sample per hour,    never pruned
 *
 * Each tier is derived from the tier below it by averaging, so a tier never
 * invents a sample that no measurement supports — a bucket with no raw
 * samples produces no aggregated sample at all. That distinction matters:
 * a gap in the graph means "we did not measure", not "the value was zero".
 *
 * Storage is one JSON Lines file per host and tier. JSONL because a partial
 * write loses one line, not the file, and because an operator can read it
 * with `tail` without a tool.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../dsh-home.ts'
import type { CheckResult } from '../inspect/checks.ts'

/** One metric sample. */
export interface MetricSample {
  /** Epoch milliseconds. */
  at: number
  /** The metric id (equal to the check id that produced it). */
  metric: string
  /** The value; null when the probe could not read it. */
  value: number | null
}

/** One aggregated bucket. */
export interface MetricBucket {
  /** Bucket start, epoch milliseconds. */
  at: number
  metric: string
  /** Mean of the raw samples in the bucket; null when every sample was blind. */
  value: number | null
  /** How many raw samples fed this bucket. */
  samples: number
}

/** A retention tier. */
export interface Tier {
  /** Tier name, also its directory name. */
  name: 'raw' | '1m' | '15m' | '1h'
  /** Bucket width in milliseconds (0 for raw, which keeps the sample's own `at`). */
  widthMs: number
  /** How long a bucket survives, in milliseconds; 0 means forever. */
  keepMs: number
}

/**
 * The tiers, coarse to fine windows.
 *
 * The raw window is deliberately short (24h): raw samples are the bulky tier,
 * and anything older is answerable from the 1m tier for a month.
 */
export const TIERS: readonly Tier[] = [
  { name: 'raw', widthMs: 0, keepMs: 24 * 60 * 60 * 1000 },
  { name: '1m', widthMs: 60 * 1000, keepMs: 30 * 24 * 60 * 60 * 1000 },
  { name: '15m', widthMs: 15 * 60 * 1000, keepMs: 90 * 24 * 60 * 60 * 1000 },
  { name: '1h', widthMs: 60 * 60 * 1000, keepMs: 0 },
]

/** The metrics store root. */
export function metricsRoot(): string {
  return join(dshHome(), 'dsh-ssh-hub', 'metrics')
}

/**
 * Sanitise an alias into a directory-safe file stem.
 *
 * Whitelist rather than blacklist: an alias comes from operator input, and a
 * blacklist that forgets one character (`.` — so `..` survives and the path
 * escapes the store root) is a path-traversal bug. Keeping only
 * `[A-Za-z0-9_-]` cannot encode a separator or a parent reference.
 */
function aliasStem(alias: string): string {
  const stem = alias.replace(/[^A-Za-z0-9_-]/g, '_')
  // A stem of only dots or empty would still be unsafe; fall back to a fixed
  // name so the store always has a writable directory.
  return /^[._-]*$/.test(stem) || stem === '' ? '_alias' : stem
}

/**
 * The file a (host, tier) pair lives in.
 *
 * @param alias - the host alias.
 * @param tier - the tier name.
 * @param root - store root override (tests).
 * @returns the absolute path.
 */
export function tierPath(alias: string, tier: Tier['name'], root = metricsRoot()): string {
  return join(root, aliasStem(alias), `${tier}.jsonl`)
}

/** Parse JSON Lines, skipping torn lines. */
function parseLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      out.push(JSON.parse(trimmed) as unknown)
    } catch {
      // A torn tail line (a crash mid-write) is expected; skip it rather
      // than losing the whole history.
    }
  }
  return out
}

/**
 * The metric store: append raw samples, derive coarser tiers, prune.
 *
 * One instance per plugin apply. Every method is synchronous: samples are
 * small and arrive once per inspection round, so a write is microseconds,
 * and making it async would only add a window in which an in-flight round's
 * samples could interleave with a prune.
 */
export class MetricStore {
  private readonly root: string

  constructor(root?: string) {
    this.root = root ?? metricsRoot()
  }

  /**
   * Append one round's samples and roll the tiers up.
   *
   * @param alias - the host alias.
   * @param samples - the samples from this round.
   */
  record(alias: string, samples: readonly MetricSample[]): void {
    if (samples.length === 0) return
    this.appendTier(alias, 'raw', samples.map(sample => ({
      at: sample.at,
      metric: sample.metric,
      value: sample.value,
    })))
    this.rollUp(alias)
  }

  /** Append entries to one tier file. */
  private appendTier(alias: string, tier: Tier['name'], entries: readonly Record<string, unknown>[]): void {
    if (entries.length === 0) return
    const path = tierPath(alias, tier, this.root)
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  }

  /** Read one tier. */
  readTier(alias: string, tier: Tier | Tier['name']): Array<Record<string, unknown>> {
    const name = typeof tier === 'string' ? tier : tier.name
    const path = tierPath(alias, name, this.root)
    if (!existsSync(path)) return []
    return parseLines(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>
  }

  /**
   * Derive every coarse tier from the tier below and prune expired buckets.
   *
   * Idempotent: a bucket that already exists is replaced, not duplicated, so
   * running this after every round converges instead of accumulating.
   */
  rollUp(alias: string): void {
    for (let index = 1; index < TIERS.length; index += 1) {
      const source = TIERS[index - 1]
      const target = TIERS[index]
      if (source === undefined || target === undefined) continue
      this.aggregate(alias, source, target)
    }
    for (const tier of TIERS) this.prune(alias, tier)
  }

  /**
   * Aggregate a finer tier into a coarser one.
   *
   * Buckets are aligned to the width, so a bucket always covers the same
   * wall-clock window regardless of when the round happened.
   */
  private aggregate(alias: string, source: Tier, target: Tier): void {
    const rows = this.readTier(alias, source).filter((row): row is { at: number; metric: string; value: number | null } =>
      typeof row['at'] === 'number' && typeof row['metric'] === 'string'
      && (row['value'] === null || typeof row['value'] === 'number'))
    if (rows.length === 0) return

    // Group by (metric, bucket start).
    const buckets = new Map<string, { at: number; metric: string; sum: number; count: number; samples: number }>()
    for (const row of rows) {
      const at = Math.floor(row.at / target.widthMs) * target.widthMs
      const key = `${row.metric}|${at}`
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = { at, metric: row.metric, sum: 0, count: 0, samples: 0 }
        buckets.set(key, bucket)
      }
      bucket.samples += 1
      // A blind sample counts as "we measured, but saw nothing" and is
      // excluded from the mean rather than counted as zero.
      if (row.value !== null) {
        bucket.sum += row.value
        bucket.count += 1
      }
    }

    // Rewrite the whole target tier: bounded by the retention window, and
    // rewriting avoids duplicate rows when a bucket is re-derived.
    const existing = this.readTier(alias, target)
      .filter((row): row is { at: number; metric: string; value: number | null; samples: number } =>
        typeof row['at'] === 'number' && typeof row['metric'] === 'string')
    const merged = new Map<string, MetricBucket>()
    for (const row of existing) {
      merged.set(`${row.metric}|${row.at}`, { at: row.at, metric: row.metric, value: row.value, samples: row.samples })
    }
    for (const [, bucket] of buckets) {
      merged.set(`${bucket.metric}|${bucket.at}`, {
        at: bucket.at,
        metric: bucket.metric,
        value: bucket.count > 0 ? bucket.sum / bucket.count : null,
        samples: bucket.samples,
      })
    }
    const sorted = [...merged.values()].sort((left, right) => left.at - right.at)
    const path = tierPath(alias, target.name, this.root)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, sorted.map(row => JSON.stringify(row)).join('\n') + (sorted.length > 0 ? '\n' : ''), 'utf8')
  }

  /** Drop buckets older than the tier's retention window. */
  private prune(alias: string, tier: Tier): void {
    if (tier.keepMs === 0) return
    const rows = this.readTier(alias, tier)
    const cutoff = Date.now() - tier.keepMs
    const kept = rows.filter(row => typeof row['at'] === 'number' && row['at'] >= cutoff)
    if (kept.length === rows.length) return
    const path = tierPath(alias, tier.name, this.root)
    writeFileSync(path, kept.map(row => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
  }

  /**
   * Read a series for display.
   *
   * @param alias - the host.
   * @param tier - which tier to read.
   * @param metric - optional metric filter.
   * @param limit - most recent N buckets (default 120).
   * @returns the series, oldest first.
   */
  series(alias: string, tier: Tier['name'], metric?: string, limit = 120): MetricBucket[] {
    const rows = this.readTier(alias, tier)
    const out: MetricBucket[] = []
    for (const row of rows) {
      if (typeof row['at'] !== 'number' || typeof row['metric'] !== 'string') continue
      if (metric !== undefined && row['metric'] !== metric) continue
      const value = row['value']
      if (value !== null && typeof value !== 'number') continue
      out.push({
        at: row['at'],
        metric: row['metric'],
        value,
        samples: typeof row['samples'] === 'number' ? row['samples'] : 1,
      })
    }
    out.sort((left, right) => left.at - right.at)
    return out.length > limit ? out.slice(out.length - limit) : out
  }
}

/**
 * Extract numeric samples from one inspection round for one host.
 *
 * Only checks with a numeric kind become metrics: a boolean check ("sshd is
 * running") has no meaningful average, and a text check has no series at all.
 * The timestamp comes from the round, because a CheckResult carries no time
 * of its own — every result in a round shares the round's start.
 *
 * @param at - the round's start, epoch milliseconds.
 * @param results - the round's results for that host.
 * @param kindOf - resolves a check id to its kind.
 * @returns the numeric samples.
 */
export function samplesFromRound(
  at: number,
  results: readonly CheckResult[],
  kindOf: (checkId: string) => string | undefined,
): MetricSample[] {
  const samples: MetricSample[] = []
  for (const item of results) {
    const kind = kindOf(item.checkId)
    if (kind !== 'percent' && kind !== 'gauge') continue
    samples.push({
      at,
      metric: item.checkId,
      value: typeof item.value === 'number' ? item.value : null,
    })
  }
  return samples
}