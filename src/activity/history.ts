/**
 * Activity history for the two surfaces that produce it: deployment runs and
 * cross-host log searches.
 *
 * Both are append-only NDJSON files under the plugin's home, bounded the same
 * way the metric tiers are: a hard cap on retained records, oldest dropped
 * first. The panel reads them as history; nothing in the host half depends on
 * them, so a missing or corrupt file degrades to "no history yet" rather than
 * failing a route.
 *
 * Why persist at all: a deployment or a log search is an operator action with
 * an outcome they need to look at *after* the panel has moved on. Keeping only
 * the in-memory result would lose it on the next panel switch — and this is
 * exactly the kind of record someone asks about a day later.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Records retained per history kind. */
const MAX_RECORDS = 100

/** One of the history files. */
export type HistoryKind = 'deploys' | 'logs'

/**
 * Append-only JSON-lines history with a fixed retention window.
 *
 * Every write is a single `appendFileSync` of one line, so a crash mid-write
 * can at worst truncate the newest record; `read()` skips unparsable lines
 * instead of throwing, which keeps one bad line from hiding all the others.
 */
export class ActivityHistory<T> {
  private readonly file: string

  /**
   * @param root - the plugin's home directory.
   * @param kind - which history file this instance owns.
   */
  constructor(root: string, private readonly kind: HistoryKind) {
    this.file = join(root, `${kind}.jsonl`)
  }

  /** The file this history writes to. */
  get path(): string {
    return this.file
  }

  /**
   * Append one record, trimming the file when it exceeds the cap.
   * @param record - the record to store.
   */
  append(record: T): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8')
      this.trim()
    } catch {
      // History is a convenience, never a precondition: a full disk must not
      // turn a successful deployment into a failed request.
    }
  }

  /**
   * Read the newest records first.
   * @param limit - maximum records to return.
   * @returns the records, newest first.
   */
  read(limit = 20): T[] {
    if (!existsSync(this.file)) return []
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const records: T[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as T)
      } catch {
        // A truncated trailing line is expected after a crash; skip it.
      }
    }
    return records.slice(-Math.max(1, limit)).reverse()
  }

  /** Drop the oldest records once the file holds more than the cap. */
  private trim(): void {
    if (!existsSync(this.file)) return
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n').filter(line => line.trim() !== '')
    if (lines.length <= MAX_RECORDS) return
    try {
      // Keep the newest records; rewriting is cheaper than an in-place edit
      // and leaves a consistent file if it fails.
      writeFileSync(this.file, `${lines.slice(-MAX_RECORDS).join('\n')}\n`, 'utf8')
    } catch {
      // Keep the larger file: retention is a courtesy, not a guarantee.
    }
  }

  /** Forget every record (the panel's "clear history"). */
  clear(): void {
    try {
      if (existsSync(this.file)) writeFileSync(this.file, '', 'utf8')
    } catch {
      // Same reasoning as append(): never fail a request over history.
    }
  }
}