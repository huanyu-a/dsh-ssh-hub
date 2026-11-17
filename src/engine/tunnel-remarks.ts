/**
 * User remarks for port forwards this plugin does not own.
 *
 * An external forward's identity (`ext-<pid>-<index>`) changes every time the
 * process behind it restarts, so a remark cannot hang off the tunnel id — it
 * would evaporate on the next restart and the row would silently revert to an
 * anonymous port. Remarks are therefore keyed by the local listening port,
 * which is the one part of a forward that survives a restart.
 *
 * Precedence when both exist: a user remark wins over `~/.ssh/forwards.conf`,
 * because the remark is the more recent, more specific statement of intent.
 * Clearing the remark (saving both fields empty) deletes the entry, and the
 * forwards.conf name shows through again — the file stays the user's, and this
 * plugin never rewrites it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.ts'

/** A name/description pair the operator attached to one local port. */
export interface TunnelRemark {
  name?: string
  description?: string
}

/** Where remarks live. Separate from the host store: no secret ever lands here. */
export function tunnelRemarksPath(): string {
  return join(dshHome(), 'dsh-ssh-hub', 'tunnel-remarks.json')
}

/** Trim a value to a remark field, treating blank as absent. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read every stored remark, keyed by local port.
 *
 * A corrupt or hand-edited file yields an empty map rather than throwing: the
 * tunnel list is the primary feature, and losing annotations must not take the
 * whole tab down with an exception.
 *
 * @param path - override for tests.
 * @returns remarks keyed by the local port as a string.
 */
export function readTunnelRemarks(path: string = tunnelRemarksPath()): Record<string, TunnelRemark> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, TunnelRemark> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Only ports are meaningful keys; anything else is junk from a bad edit.
    if (!/^\d+$/.test(key)) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const remark: TunnelRemark = {}
    const name = clean(record.name)
    const description = clean(record.description)
    if (name !== undefined) remark.name = name
    if (description !== undefined) remark.description = description
    if (remark.name !== undefined || remark.description !== undefined) out[key] = remark
  }
  return out
}

/** Replace the whole remarks file (atomic via a 0600 temp file + rename). */
export function writeTunnelRemarks(remarks: Record<string, TunnelRemark>, path: string = tunnelRemarksPath()): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(remarks, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Replace the remark for one port.
 *
 * The pair is replaced wholesale rather than merged: the edit dialog shows both
 * fields at once, so "empty" is an instruction to clear that field, not to keep
 * the old value. When both end up empty the entry is removed entirely, which is
 * how `~/.ssh/forwards.conf` becomes visible again.
 *
 * @param localPort - the listening port that identifies the forward.
 * @param remark - the desired pair; absent fields mean cleared.
 * @param path - override for tests.
 * @returns the stored remark, or undefined when the entry was deleted.
 */
export function setTunnelRemark(
  localPort: number,
  remark: TunnelRemark,
  path: string = tunnelRemarksPath(),
): TunnelRemark | undefined {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('localPort must be an integer in 1..65535')
  }
  const remarks = readTunnelRemarks(path)
  const key = String(localPort)
  const next: TunnelRemark = {}
  const name = clean(remark.name)
  const description = clean(remark.description)
  if (name !== undefined) next.name = name
  if (description !== undefined) next.description = description
  if (next.name === undefined && next.description === undefined) {
    if (remarks[key] === undefined) return undefined
    delete remarks[key]
    writeTunnelRemarks(remarks, path)
    return undefined
  }
  remarks[key] = next
  writeTunnelRemarks(remarks, path)
  return next
}
