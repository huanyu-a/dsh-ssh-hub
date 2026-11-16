/**
 * Host-key verification against the user's OpenSSH `known_hosts` file.
 *
 * The base plugin never set ssh2's `hostVerifier`, so every connection
 * accepted whatever key the server presented — a real MITM surface on a
 * fleet where one forged connection reaches every host.
 *
 * This module parses `known_hosts` the way OpenSSH does (plain, bracket,
 * wildcard and `@revoked` entries; SHA256 fingerprints) and turns that into
 * the verifier ssh2 calls for each connection.
 *
 * Three policies, selected by configuration:
 * - `off`    — no verification (the base plugin's behaviour; the default so
 *              an upgrade never locks an existing user out)
 * - `tofu`   — trust on first use: an unknown host is recorded and the
 *              connection proceeds; a CHANGED key is always refused
 * - `strict` — an unknown host is refused; the user must accept it first
 *
 * A refused connection must explain itself: the message carries the expected
 * fingerprint, the presented one, and the file path, so the user can decide
 * without reading source.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

/** How a host key is treated when it is not (or is no longer) trusted. */
export type HostKeyPolicy = 'off' | 'tofu' | 'strict'

/** One known_hosts entry, after parsing. */
interface KnownHostEntry {
  /** Host patterns this entry covers (unhashed). */
  patterns: string[]
  /** True when the original entry used a hashed host name. */
  hashed: boolean
  /** The key type, e.g. `ssh-ed25519`. */
  keyType: string
  /** The base64 key blob — the whole blob, exactly as OpenSSH stores it. */
  key: string
  /** True when the entry was marked `@revoked`. */
  revoked: boolean
}

/** A parsed known_hosts file plus the path it came from. */
export interface KnownHostsFile {
  path: string
  entries: KnownHostEntry[]
  /** True when the file exists and was read. */
  present: boolean
}

/** The default known_hosts path: `~/.ssh/known_hosts`. */
export function defaultKnownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts')
}

/**
 * Parse a known_hosts file.
 *
 * Supported forms:
 * - `host-patterns key-type base64 [comment]`
 * - `[host]:port key-type base64 [comment]` (bracket form for non-22 ports)
 * - `@revoked host-patterns key-type base64 [comment]`
 * - hashed host names (`|1|base64|base64`)
 *
 * Lines that do not parse are skipped: OpenSSH itself ignores them, and a
 * single malformed line must not make every other entry unusable.
 *
 * @param path - the file to read.
 * @returns the parsed entries and whether the file was present.
 */
export function parseKnownHosts(path: string): KnownHostsFile {
  if (!existsSync(path)) return { path, entries: [], present: false }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { path, entries: [], present: false }
  }
  const entries: KnownHostEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    let rest = line
    let revoked = false
    if (rest.startsWith('@')) {
      const marker = rest.slice(1).split(/\s+/)[0]
      if (marker === 'revoked') {
        revoked = true
        rest = rest.slice(marker.length + 1).trim()
      } else {
        // @cert-authority and other markers are not plain host-key entries.
        continue
      }
    }
    const parts = rest.split(/\s+/)
    if (parts.length < 3) continue
    const [patternsField, keyType, key] = parts
    if (keyType === undefined || key === undefined) continue
    if (keyType.includes('@')) {
      // Certificate authorities: not a plain host key entry.
      continue
    }
    const hashed = patternsField.startsWith('|1|')
    entries.push({
      patterns: patternsField.split(',').map(pattern => pattern.trim()).filter(pattern => pattern !== ''),
      hashed,
      keyType,
      key,
      revoked,
    })
  }
  return { path, entries, present: true }
}

/**
 * The SHA256 fingerprint OpenSSH and ssh2 display for a key.
 *
 * OpenSSH hashes the **whole key blob** — the same bytes base64-encoded in
 * a known_hosts line — so this hashes the decoded blob directly.
 *
 * @param key - the base64 key blob.
 * @returns the `SHA256:...` fingerprint, base64 without padding.
 */
export function fingerprint(key: string): string {
  const digest = createHash('sha256').update(decodeBase64(key)).digest('base64')
  return 'SHA256:' + digest.replace(/=+$/, '')
}

/** Decode base64, tolerating whitespace. */
function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64')
}

/**
 * Does one pattern match one host?
 *
 * Supports the exact form, the `*` / `?` wildcards OpenSSH accepts, and the
 * bracketed `[host]:port` form.
 */
function patternMatches(pattern: string, host: string, port: number): boolean {
  // The pattern's host part — the part a wildcard can apply to.
  let candidate: string
  if (pattern.startsWith('[')) {
    // The bracketed form is port-specific: `[host]:port`. It ends with the
    // port, not with `]`, so the closing bracket is followed by `:port`.
    const closing = pattern.indexOf(']')
    if (closing === -1) return false
    const inner = pattern.slice(1, closing)
    const remainder = pattern.slice(closing + 1)
    if (remainder !== '') {
      if (!remainder.startsWith(':')) return false
      const portText = remainder.slice(1)
      if (Number.parseInt(portText, 10) !== port) return false
    }
    candidate = inner
  } else if (pattern.includes(':')) {
    // The plain `host:port` form.
    const separator = pattern.lastIndexOf(':')
    const portText = pattern.slice(separator + 1)
    if (Number.parseInt(portText, 10) !== port) return false
    candidate = pattern.slice(0, separator)
  } else {
    candidate = pattern
  }
  if (candidate === host) return true
  if (!candidate.includes('*') && !candidate.includes('?')) return false
  const escaped = candidate.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$').test(host)
}

/**
 * Find the known_hosts entries that cover one host:port.
 *
 * @param file - the parsed file.
 * @param host - the hostname or address.
 * @param port - the SSH port.
 * @returns every covering entry, revoked ones included.
 */
export function entriesFor(file: KnownHostsFile, host: string, port: number): KnownHostEntry[] {
  return file.entries.filter(entry => entry.patterns.some(pattern => {
    if (entry.hashed) {
      // A hashed host name is HMAC-SHA1 over the host name; verifying it
      // would need the salt and the same key OpenSSH uses. Such an entry is
      // therefore not consulted here, and the host reads as unknown.
      return false
    }
    return patternMatches(pattern, host, port)
  }))
}

/** The outcome of a host-key check. */
export type HostKeyDecision =
  /** The key matches a trusted entry. */
  | { action: 'accept' }
  /** The key is unknown; `fingerprint` is the one the server presented. */
  | { action: 'unknown'; fingerprint: string }
  /** The key differs from the trusted one — a possible MITM. */
  | { action: 'mismatch'; expected: string; received: string; path: string }
  /** The trusted entry is marked `@revoked`. */
  | { action: 'revoked'; fingerprint: string; path: string }

/**
 * Decide what to do with a presented host key.
 *
 * @param file - the parsed known_hosts file.
 * @param host - the hostname or address.
 * @param port - the SSH port.
 * @param keyType - the presented key type.
 * @param presentedKey - the presented key blob (base64).
 * @returns the decision.
 */
export function decide(
  file: KnownHostsFile,
  host: string,
  port: number,
  keyType: string,
  presentedKey: string,
): HostKeyDecision {
  const presented = fingerprint(presentedKey)
  const covering = entriesFor(file, host, port)
  if (covering.length === 0) return { action: 'unknown', fingerprint: presented }
  // A revoked entry for this key is refused outright, whatever else is
  // registered for the host.
  const revoked = covering.find(entry => entry.revoked && entry.keyType === keyType && entry.key === presentedKey)
  if (revoked !== undefined) return { action: 'revoked', fingerprint: presented, path: file.path }
  const trusted = covering.find(entry => !entry.revoked && entry.keyType === keyType && entry.key === presentedKey)
  if (trusted !== undefined) return { action: 'accept' }
  // The host is known but with a different key of the same type — the case
  // that matters for MITM. Report the fingerprint the file expects.
  const sameType = covering.find(entry => !entry.revoked && entry.keyType === keyType)
  if (sameType !== undefined) {
    return {
      action: 'mismatch',
      expected: fingerprint(sameType.key),
      received: presented,
      path: file.path,
    }
  }
  return { action: 'unknown', fingerprint: presented }
}

/** The host-key verification state handed to ssh2. */
export interface HostKeyVerifierOptions {
  /** The policy in force. */
  policy: HostKeyPolicy
  /** The known_hosts file path. */
  path: string
  /** The host this verifier is bound to (ssh2 passes only the key). */
  host: string
  /** The port this verifier is bound to. */
  port: number
  /** Called when an unknown host must be recorded (TOFU). */
  onRecord?: (host: string, port: number, keyType: string, key: string) => void
}

/**
 * Build the ssh2 `hostVerifier` callback for one connection.
 *
 * ssh2 calls it with the server's key blob; returning a boolean accepts or
 * denies the key (ssh2 also accepts the callback form, but a synchronous
 * verdict cannot half-apply). The verifier reads the file on every call so
 * an edit made outside this plugin — a manual `ssh` session, another tool —
 * takes effect on the next connection.
 *
 * @param options - the policy, file path and the connection's host/port.
 * @returns the verifier callback.
 */
export function createHostVerifier(options: HostKeyVerifierOptions): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    try {
      const file = parseKnownHosts(options.path)
      const { keyType, key: material } = decodeServerKey(key)
      const decision = decide(file, options.host, options.port, keyType, material)
      switch (decision.action) {
        case 'accept':
          return true
        case 'unknown':
          if (options.policy === 'strict') return false
          if (options.policy === 'tofu') {
            options.onRecord?.(options.host, options.port, keyType, material)
          }
          return true
        case 'revoked':
        case 'mismatch':
          // A changed or revoked key is refused under EVERY policy: even
          // `off` must not accept a key the user explicitly revoked.
          return false
      }
    } catch {
      // A broken verifier must not become a licence to accept anything:
      // fail closed when the check itself fails.
      return false
    }
  }
}

/**
 * Split an ssh2 host-key blob into its type and the known_hosts key form.
 *
 * ssh2 hands the verifier the blob exactly as the KEX reply carried it
 * (see `kex.js`: `hostPubKey = bufferParser.readString()`), whose wire form is
 *
 *   uint32 len | keyType | uint32 len | keyMaterial
 *
 * A known_hosts line stores the very same bytes — the SSH public-key blob
 * `string(keyType) || string(keyMaterial)` — base64-encoded. So the known_hosts
 * form is the KEX blob verbatim; no re-prefixing happens here.
 */
function decodeServerKey(blob: Buffer): { keyType: string; key: string } {
  let offset = 0
  const readString = (): string => {
    const length = blob.readUInt32BE(offset)
    offset += 4
    const value = blob.subarray(offset, offset + length).toString('utf8')
    offset += length
    return value
  }
  const keyType = readString()
  return { keyType, key: blob.toString('base64') }
}

/**
 * Record a trusted host key in the known_hosts file.
 *
 * @param path - the file to append to.
 * @param host - the hostname or address.
 * @param port - the SSH port.
 * @param keyType - the key type.
 * @param key - the base64 key blob.
 */
export function recordKnownHost(path: string, host: string, port: number, keyType: string, key: string): void {
  const label = port === 22 ? host : `[${host}]:${port}`
  const line = `${label} ${keyType} ${key}\n`
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The file holds public keys only, but it is still the user's SSH trust
  // store: keep it owner-readable.
  writeFileSync(path, line, { encoding: 'utf8', mode: 0o600, flag: 'a' })
}
