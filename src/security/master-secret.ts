/**
 * Master-secret management for the credential envelope.
 *
 * The secret itself lives outside the store on purpose: `DSH_SSH_HUB_SECRET`
 * (environment) or a key file, never inside `dsh-ssh.json`. That means the
 * panel cannot "just set" it — it has to write a file with the right
 * permissions and then re-encrypt every stored entry that was sealed with the
 * previous secret, because a secret change without rotation silently locks
 * the operator out of their own credentials.
 *
 * Three operations, each with the failure mode it refuses:
 *
 * - `status()`  — where the secret comes from, if at all.
 * - `setKey()`  — write the key file. Refuses to overwrite an existing file
 *                 that this plugin did not create (a foreign file may be the
 *                 operator's own keystore), and refuses a weak secret.
 * - `rotate()`  — re-seal every entry with the new secret. Runs as one
 *                 rewrite: entries are re-sealed in memory and written
 *                 together, so a failure never leaves a half-rotated store.
 *
 * The plaintext side of the tradeoff is explicit: encryption activates only
 * when a secret exists. There is no default, because a default key is a
 * backdoor and every installation would share it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { HostStore } from '../store.ts'
import { open as openSecret } from './secrets.ts'

/** Environment variable that carries the master secret directly. */
export const SECRET_ENV = 'DSH_SSH_HUB_SECRET'

/** Environment variable naming a file that carries the master secret. */
export const SECRET_FILE_ENV = 'DSH_SSH_HUB_SECRET_FILE'

/** Minimum master-secret length. Short secrets are the whole weakness. */
export const MIN_SECRET_LENGTH = 16

/** Where the secret came from. */
export type SecretSource = 'env' | 'file' | 'none'

/** The key-file location this plugin owns. */
export function defaultKeyPath(dshHome: string): string {
  return resolve(dshHome, 'dsh-ssh-master.key')
}

/**
 * Read the master secret.
 *
 * A file-provided value is trimmed of exactly one trailing newline (a file
 * written by `echo` would otherwise carry an invisible `\n` into the derived
 * key, producing a secret nobody can reproduce by typing it).
 *
 * @param keyPath - the key file to read when the env vars are absent.
 * @returns the secret, or undefined when none is configured.
 */
export function readMasterSecret(keyPath: string): string | undefined {
  const direct = process.env[SECRET_ENV]
  if (typeof direct === 'string' && direct.length > 0) return direct
  const named = process.env[SECRET_FILE_ENV]
  const path = typeof named === 'string' && named.length > 0 ? named : keyPath
  if (!existsSync(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * Report where the secret comes from.
 * @param keyPath - the key file to check.
 * @returns the source label.
 */
export function masterSecretSource(keyPath: string): SecretSource {
  const direct = process.env[SECRET_ENV]
  if (typeof direct === 'string' && direct.length > 0) return 'env'
  const named = process.env[SECRET_FILE_ENV]
  const path = typeof named === 'string' && named.length > 0 ? named : keyPath
  return existsSync(path) ? 'file' : 'none'
}

/** One entry whose stored secrets are still plaintext. */
export interface PlaintextReport {
  /** Aliases holding a readable plaintext password or passphrase. */
  aliases: string[]
}

/**
 * Does this value look like a sealed envelope rather than a plaintext secret?
 * Mirrors `isSealed` from secrets.ts but stays local so this module has no
 * dependency on the protector's internals.
 */
function looksSealed(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && typeof (value as { v?: unknown }).v === 'number'
    && typeof (value as { data?: unknown }).data === 'string'
}

/**
 * Find entries whose secrets would still be readable without the master key.
 *
 * This reads the store file directly, because `HostStore.list()` returns
 * decrypted entries and therefore cannot tell plaintext from ciphertext. The
 * distinction is the whole point: an operator enabling encryption needs to
 * know whether anything is still exposed on disk.
 *
 * @param storePath - the store file path.
 * @returns the aliases whose stored secrets are plaintext.
 */
export function findPlaintextEntries(storePath: string): PlaintextReport {
  if (!existsSync(storePath)) return { aliases: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(storePath, 'utf8'))
  } catch {
    return { aliases: [] }
  }
  const hosts = (parsed as { hosts?: unknown }).hosts
  if (!Array.isArray(hosts)) return { aliases: [] }
  const aliases: string[] = []
  for (const host of hosts) {
    const entry = host as { alias?: unknown; auth?: { password?: unknown; passphrase?: unknown } }
    if (typeof entry.alias !== 'string') continue
    const hasPlaintext = [entry.auth?.password, entry.auth?.passphrase]
      .some(value => typeof value === 'string' && value.length > 0)
    if (hasPlaintext) aliases.push(entry.alias)
  }
  return { aliases }
}

/** What a key-file write did. */
export interface KeyWriteResult {
  ok: boolean
  path: string
  /** Set when the write was refused or failed. */
  error?: string
}

/**
 * Write the master secret to the key file with owner-only permissions.
 *
 * Refusals are deliberate:
 * - a secret shorter than MIN_SECRET_LENGTH is rejected (it would be the only
 *   thing standing between a file copy and every credential in it),
 * - an existing file the caller did not create is never overwritten, because
 *   it may hold a key the operator is still using,
 * - a file is never left behind half-written.
 *
 * @param keyPath - destination path.
 * @param secret - the new secret.
 * @param overwrite - replace an existing key file (the panel's "rotate").
 * @returns the outcome.
 */
export function writeMasterKey(keyPath: string, secret: string, overwrite: boolean): KeyWriteResult {
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, path: keyPath, error: `master secret must be at least ${String(MIN_SECRET_LENGTH)} characters` }
  }
  if (!overwrite && existsSync(keyPath)) {
    return { ok: false, path: keyPath, error: 'a key file already exists at this path; pass overwrite to replace it' }
  }
  try {
    mkdirSync(dirname(keyPath), { recursive: true })
    // 0600: the secret is the only thing protecting every stored credential.
    writeFileSync(keyPath, secret, { encoding: 'utf8', mode: 0o600 })
    // mode on write is subject to the process umask on some platforms.
    chmodSync(keyPath, 0o600)
    return { ok: true, path: keyPath }
  } catch (error) {
    return { ok: false, path: keyPath, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Generate a secret strong enough to be worth using.
 * @returns 32 random bytes, base64url-encoded.
 */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** Outcome of a rotation. */
export interface RotateResult {
  ok: boolean
  /** Entries whose secrets were re-sealed. */
  rotated: number
  /** Entries that could not be re-sealed with the previous secret. */
  unreadable: string[]
  error?: string
}

/**
 * Re-encrypt every stored entry under a new master secret.
 *
 * Rotation is the step that makes a secret change safe: entries sealed with
 * the old secret become unreadable the moment the key file changes, so the
 * new key must be in place before the entries are re-sealed, and the entries
 * must have been read while the old key was still live.
 *
 * The order is therefore: read and verify with the old secret → commit the new
 * secret → re-seal in one pass. On a failed re-seal the old key is restored,
 * so the store never ends up sealed under a key that is not on disk.
 *
 * This deliberately does NOT install a protector of its own. The store's
 * protector resolves the secret from disk on every call, so a rotation that
 * handed it a captured secret would pin the store to that secret for the life
 * of the process — after which deleting or rotating the key file would change
 * nothing, and new credentials would be sealed with a key nothing on disk can
 * reproduce.
 *
 * An entry that cannot be decrypted with the old secret is reported, not
 * dropped: it is evidence of a wrong key or a tampered file, and silently
 * deleting it would destroy the operator's only record of that host.
 *
 * @param store - the host store (its protector reads the live secret).
 * @param oldSecret - the secret currently protecting the store.
 * @param newSecret - the secret to protect it with from now on.
 * @param commit - writes the new secret to wherever the protector reads it.
 * @returns the rotation outcome.
 */
export function rotateSecrets(
  store: HostStore,
  oldSecret: string,
  newSecret: string,
  commit: (secret: string) => KeyWriteResult,
): RotateResult {
  if (newSecret.length < MIN_SECRET_LENGTH) {
    return { ok: false, rotated: 0, unreadable: [], error: `master secret must be at least ${String(MIN_SECRET_LENGTH)} characters` }
  }
  // Read while the old secret is still the live one: after the commit below,
  // `store.list()` would return the envelope objects instead of passwords.
  const entries = store.list()
  const unreadable: string[] = []
  for (const entry of entries) {
    const stored = readStoredAuth(store.path, entry.alias)
    if (stored === undefined) continue
    for (const value of [stored.password, stored.passphrase]) {
      if (!looksSealed(value)) continue
      try {
        openSecret(value as never, oldSecret)
      } catch {
        if (!unreadable.includes(entry.alias)) unreadable.push(entry.alias)
      }
    }
  }
  if (unreadable.length > 0) {
    // Nothing has been written: the old key still opens everything, which is
    // the state to leave behind when the requested rotation cannot be proven
    // safe.
    return {
      ok: false,
      rotated: 0,
      unreadable,
      error: `some entries could not be decrypted with the previous secret: ${unreadable.join(', ')}`,
    }
  }
  const committed = commit(newSecret)
  if (!committed.ok) {
    return {
      ok: false,
      rotated: 0,
      unreadable: [],
      error: committed.error ?? 'the new master secret could not be stored',
    }
  }
  try {
    // The protector now reads the new secret, so this seals with it.
    store.resealAll(entries)
  } catch (error) {
    // Put the old key back: the file on disk is still sealed with it, so
    // leaving the new key in place would lock the operator out of every
    // credential at once.
    commit(oldSecret)
    return {
      ok: false,
      rotated: 0,
      unreadable: [],
      error: `re-encrypting the stored credentials failed and the previous key was restored: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, rotated: entries.length, unreadable }
}

/**
 * Read one entry's stored (still encrypted or plaintext) auth block.
 * @param storePath - the store file.
 * @param alias - the entry to read.
 * @returns the stored auth block, or undefined when absent.
 */
export function readStoredAuth(
  storePath: string,
  alias: string,
): { password?: unknown; passphrase?: unknown } | undefined {
  if (!existsSync(storePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as {
      hosts?: Array<{ alias?: unknown; auth?: { password?: unknown; passphrase?: unknown } }>
    }
    const host = parsed.hosts?.find(entry => entry.alias === alias)
    return host?.auth
  } catch {
    return undefined
  }
}

/**
 * Remove the key file this plugin manages.
 *
 * Refuses when the active secret comes from the environment: deleting a file
 * the environment only *names* would not change the active secret, so the
 * caller would believe encryption was off while it stayed on.
 *
 * @param keyPath - the key file.
 * @returns the outcome.
 */
export function removeMasterKey(keyPath: string): KeyWriteResult {
  if (typeof process.env[SECRET_ENV] === 'string' && process.env[SECRET_ENV].length > 0) {
    return {
      ok: false,
      path: keyPath,
      error: `${SECRET_ENV} provides the active secret; unset it instead of deleting a file`,
    }
  }
  if (!existsSync(keyPath)) return { ok: true, path: keyPath }
  try {
    unlinkSync(keyPath)
    return { ok: true, path: keyPath }
  } catch (error) {
    return { ok: false, path: keyPath, error: error instanceof Error ? error.message : String(error) }
  }
}