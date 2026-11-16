/**
 * Metric store tests: tier derivation, retention, and the "a gap means we
 * did not measure" rule.
 *
 * Every case writes real files under a temp root, because the store's whole
 * job is the shape of what lands on disk — asserting against an in-memory
 * double would test nothing that ships.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MetricStore,
  TIERS,
  samplesFromRound,
  tierPath,
  type MetricSample,
} from '../src/monitor/metrics.ts'
import type { CheckResult } from '../src/inspect/checks.ts'

/** A fresh store rooted in a temp dir. */
function freshStore(): { store: MetricStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-metrics-'))
  return { store: new MetricStore(root), root }
}

/**
 * A minute boundary close to now.
 *
 * Samples must be recent (the raw tier prunes past 24h), and bucket
 * alignment is only observable from a timestamp that is not already
 * aligned — hence a minute start plus an offset.
 */
const NOW = Math.floor(Date.now() / 60_000) * 60_000

/** The bucket start that a timestamp falls in, for a given width. */
function bucketStart(at: number, widthMs: number): number {
  return Math.floor(at / widthMs) * widthMs
}

/** One sample at a fixed time. */
function sample(at: number, metric: string, value: number | null): MetricSample {
  return { at, metric, value }
}

/** A CheckResult with only the fields the extractor reads. */
function result(checkId: string, value: number | boolean | string | null): CheckResult {
  return { checkId, alias: 'h1', value, breached: false, raw: '' }
}

/** The kind lookup the plugin passes in. */
const kindOf = (checkId: string): string | undefined => {
  if (checkId === 'disk-usage' || checkId === 'memory-used') return 'percent'
  if (checkId === 'load-average') return 'gauge'
  if (checkId === 'sshd-running') return 'boolean'
  return undefined
}

describe('tier layout', () => {
  it('declares the four tiers coarse-first with widening windows', () => {
    expect(TIERS.map(tier => tier.name)).toEqual(['raw', '1m', '15m', '1h'])
    // Each tier keeps at least as long as the one below it, or forever.
    const raw = TIERS[0]!
    const minute = TIERS[1]!
    const quarter = TIERS[2]!
    const hour = TIERS[3]!
    expect(minute.keepMs).toBeGreaterThan(raw.keepMs)
    expect(quarter.keepMs).toBeGreaterThan(minute.keepMs)
    expect(hour.keepMs).toBe(0)
  })

  it('sanitises an alias into a safe directory name', () => {
    const path = tierPath('web/../prod;rm -rf', 'raw', '/tmp/root')
    expect(path).not.toContain('..')
    expect(path).not.toContain(';')
    expect(path.endsWith('raw.jsonl')).toBe(true)
  })
})

describe('record', () => {
  it('writes raw samples and creates the directory', () => {
    const { store, root } = freshStore()
    store.record('h1', [sample(NOW, 'disk-usage', 40), sample(NOW, 'load-average', 0.5)])
    const path = tierPath('h1', 'raw', root)
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ metric: 'disk-usage', value: 40 })
  })

  it('records nothing for an empty sample set', () => {
    const { store, root } = freshStore()
    store.record('h1', [])
    expect(existsSync(tierPath('h1', 'raw', root))).toBe(false)
  })
})

describe('aggregation', () => {
  it('averages raw samples into the next tier', () => {
    const { store } = freshStore()
    // Two samples inside the same minute.
    store.record('h1', [
      sample(NOW, 'disk-usage', 40),
      sample(NOW + 500, 'disk-usage', 60),
    ])
    const minute = store.readTier('h1', '1m')
    expect(minute).toHaveLength(1)
    expect(minute[0]).toMatchObject({ at: NOW, metric: 'disk-usage', value: 50, samples: 2 })
  })

  it('aligns buckets to the width, not to the first sample', () => {
    const { store } = freshStore()
    store.record('h1', [sample(NOW + 31_000, 'disk-usage', 10)])
    const minute = store.readTier('h1', '1m')
    // A sample 31s into the minute still reports the minute's start.
    expect(minute[0]).toMatchObject({ at: bucketStart(NOW + 31_000, 60_000) })
  })

  it('excludes blind samples from the mean instead of counting them as zero', () => {
    const { store } = freshStore()
    store.record('h1', [
      sample(NOW, 'disk-usage', 80),
      sample(NOW + 100, 'disk-usage', null),
    ])
    const minute = store.readTier('h1', '1m')
    // Mean of the readable samples only: 80, not 40.
    expect(minute[0]).toMatchObject({ value: 80, samples: 2 })
  })

  it('reports null when every sample in a bucket was blind', () => {
    const { store } = freshStore()
    store.record('h1', [sample(NOW, 'disk-usage', null)])
    const minute = store.readTier('h1', '1m')
    expect(minute[0]).toMatchObject({ value: null, samples: 1 })
  })

  it('derives the coarse tiers from the one below, not from raw', () => {
    const { store } = freshStore()
    // Two samples inside one 15-minute window. Both are placed inside the
    // window that NOW falls in, rather than NOW and NOW+60s — which can
    // straddle a quarter-hour boundary and make this test time-of-day
    // dependent (it passed or failed depending on when the suite ran).
    const windowStart = bucketStart(NOW, 15 * 60_000)
    store.record('h1', [sample(windowStart + 60_000, 'disk-usage', 20)])
    store.record('h1', [sample(windowStart + 120_000, 'disk-usage', 40)])
    const quarter = store.readTier('h1', '15m')
    expect(quarter).toHaveLength(1)
    expect(quarter[0]).toMatchObject({ at: windowStart, value: 30, samples: 2 })
  })

  it('does not duplicate a bucket when the same round is rolled up twice', () => {
    const { store } = freshStore()
    store.record('h1', [sample(NOW, 'disk-usage', 40)])
    // rollUp runs again; the bucket must be replaced, not appended.
    store.rollUp('h1')
    store.rollUp('h1')
    expect(store.readTier('h1', '1m')).toHaveLength(1)
  })

  it('keeps separate series per metric', () => {
    const { store } = freshStore()
    store.record('h1', [sample(NOW, 'disk-usage', 40), sample(NOW, 'load-average', 2)])
    const minute = store.readTier('h1', '1m')
    expect(minute).toHaveLength(2)
    expect(new Set(minute.map(row => row['metric']))).toEqual(new Set(['disk-usage', 'load-average']))
  })
})

describe('retention', () => {
  it('prunes raw samples past the raw window', () => {
    const { store, root } = freshStore()
    const old = Date.now() - TIERS[0]!.keepMs - 60_000
    store.record('h1', [sample(old, 'disk-usage', 40), sample(Date.now(), 'disk-usage', 50)])
    const raw = store.readTier('h1', 'raw')
    expect(raw).toHaveLength(1)
    expect(raw[0]).toMatchObject({ value: 50 })
    void root
  })

  it('never prunes the hour tier', () => {
    const { store, root } = freshStore()
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000
    // Seed a sample first so the store creates the host directory, then
    // replace the hour file with one bucket far outside every other window.
    store.record('h1', [sample(NOW, 'disk-usage', 40)])
    writeFileSync(tierPath('h1', '1h', root), JSON.stringify({ at: ancient, metric: 'disk-usage', value: 40, samples: 1 }) + '\n')
    // Any roll-up prunes every tier; the hour tier must survive it.
    store.rollUp('h1')
    const hours = store.readTier('h1', '1h')
    // The 400-day-old bucket is still there: the hour tier is the archive.
    expect(hours.some(row => row['at'] === ancient)).toBe(true)
  })
})

describe('series', () => {
  it('returns buckets oldest-first and honours the metric filter', () => {
    const { store } = freshStore()
    store.record('h1', [sample(NOW, 'disk-usage', 40), sample(NOW, 'load-average', 1)])
    store.record('h1', [sample(NOW + 60_000, 'disk-usage', 50)])
    const series = store.series('h1', '1m', 'disk-usage')
    expect(series.map(bucket => bucket.value)).toEqual([40, 50])
    expect(series.every(bucket => bucket.metric === 'disk-usage')).toBe(true)
  })

  it('returns an empty series for a host that was never sampled', () => {
    const { store } = freshStore()
    expect(store.series('nobody', '1m')).toEqual([])
  })

  it('keeps only the most recent N buckets', () => {
    const { store } = freshStore()
    for (let index = 0; index < 10; index += 1) {
      store.record('h1', [sample(NOW + index * 60_000, 'disk-usage', index)])
    }
    const series = store.series('h1', '1m', undefined, 3)
    expect(series).toHaveLength(3)
    // The newest three, not the oldest three.
    expect(series.map(bucket => bucket.value)).toEqual([7, 8, 9])
  })
})

describe('samplesFromRound', () => {
  it('keeps numeric checks and drops boolean and text ones', () => {
    const samples = samplesFromRound(
      1_000,
      [result('disk-usage', 40), result('sshd-running', true), result('kernel', 'Linux')],
      kindOf,
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]).toMatchObject({ at: 1_000, metric: 'disk-usage', value: 40 })
  })

  it('records an unreadable numeric check as a blind sample, not as absent', () => {
    const samples = samplesFromRound(1_000, [result('disk-usage', null)], kindOf)
    expect(samples).toEqual([{ at: 1_000, metric: 'disk-usage', value: null }])
  })

  it('drops a check whose kind is unknown', () => {
    const samples = samplesFromRound(1_000, [result('mystery', 5)], kindOf)
    expect(samples).toEqual([])
  })
})

describe('MetricStore.forget', () => {
  it('removes every tier for one alias and leaves the others alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-metrics-forget-'))
    const store = new MetricStore(root)
    store.record('gone', [{ at: NOW, metric: 'disk-usage', value: 50 }])
    store.record('kept', [{ at: NOW, metric: 'disk-usage', value: 60 }])
    expect(store.readTier('gone', 'raw')).toHaveLength(1)

    expect(store.forget('gone')).toBe(true)
    expect(existsSync(join(root, 'gone'))).toBe(false)
    expect(store.readTier('gone', 'raw')).toEqual([])
    expect(store.readTier('gone', '1m')).toEqual([])
    // The other host is untouched: removal must not be a directory-wide wipe.
    expect(store.readTier('kept', 'raw')).toHaveLength(1)
  })

  it('reports false when there is nothing to remove', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-metrics-forget2-'))
    const store = new MetricStore(root)
    expect(store.forget('never-seen')).toBe(false)
  })

  it('deletes by the sanitised stem, not the raw alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-metrics-forget3-'))
    const store = new MetricStore(root)
    // A dot in the alias lands as an underscore on disk; forget has to use the
    // same mapping or it would look in the wrong place and silently do nothing.
    store.record('a.b', [{ at: NOW, metric: 'disk-usage', value: 50 }])
    expect(store.forget('a.b')).toBe(true)
    expect(store.readTier('a.b', 'raw')).toEqual([])
  })
})