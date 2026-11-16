/**
 * Credential encryption: an encrypted envelope for the secrets that live
 * alongside a host entry (passwords, key passphrases).
 *
 * The base plugin stored those in plaintext inside `dsh-ssh.json` — a
 * user-owned file, but plaintext means every backup, every accidental
 * copy and every process running as the same user can read them.
 *
 * The envelope here is deliberately simple and auditable:
 * - a random 32-byte data key encrypts the payload (AES-256-GCM)
 * - the data key is itself wrapped with a key derived from a master secret
 *   (scrypt, with a per-file random salt)
 * - authentication is GCM's, so a tampered file fails to decrypt rather
 *   than yielding garbage
 *
 * The master secret comes from the environment (`DSH_SSH_HUB_SECRET`), a
 * key file, or the DSH credentials service. There is deliberately NO
 * default: a default master secret would be a backdoor, and silently
 * falling back to plaintext would defeat the point of encrypting at all.
 * When no secret is configured, `secretsEnabled` is false and the store
 * keeps the base plugin's plaintext behaviour.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

/** The envelope version, so a future format change can be detected. */
export const ENVELOPE_VERSION = 1

/** The encrypted form of one secret. */
export interface SealedSecret {
  /** Envelope version. */
  v: number
  /** Algorithm tag ('aes-256-gcm'). */
  alg: string
  /** Base64 salt for the key derivation. */
  salt: string
  /** Base64 initialisation vector. */
  iv: string
  /** Base64 authentication tag. */
  tag: string
  /** Base64 ciphertext. */
  data: string
}

/** The scrypt cost parameters. */
const SCRYPT_KEYLEN = 32
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const

/**
 * Derive the wrapping key from the master secret and the file salt.
 *
 * @param secret - the master secret.
 * @param salt - the per-file random salt.
 * @returns the 32-byte wrapping key.
 */
function deriveWrappingKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS)
}

/**
 * Encrypt one secret value.
 *
 * Two layers, each with its own IV — GCM requires a unique nonce per key,
 * so the payload cipher and the key-wrap cipher must never share one.
 *
 * @param plaintext - the secret to protect.
 * @param masterSecret - the master secret.
 * @returns the sealed envelope.
 */
export function seal(plaintext: string, masterSecret: string): SealedSecret {
  const salt = randomBytes(16)
  // One IV per cipher: reusing a nonce across keys is exactly the mistake
  // GCM punishes.
  const dataIv = randomBytes(12)
  const wrapIv = randomBytes(12)
  const wrappingKey = deriveWrappingKey(masterSecret, salt)
  // The data key is random per secret; only it touches the plaintext.
  const dataKey = randomBytes(32)
  const cipher = createCipheriv('aes-256-gcm', dataKey, dataIv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const wrapper = createCipheriv('aes-256-gcm', wrappingKey, wrapIv)
  const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()])
  const wrapperTag = wrapper.getAuthTag()
  return {
    v: ENVELOPE_VERSION,
    alg: 'aes-256-gcm',
    salt: salt.toString('base64'),
    // Both IVs travel together, each still unique to its cipher.
    iv: Buffer.concat([wrapIv, dataIv]).toString('base64'),
    tag: Buffer.concat([wrapperTag, tag]).toString('base64'),
    data: Buffer.concat([wrappedKey, ciphertext]).toString('base64'),
  }
}

/**
 * Decrypt one sealed secret.
 *
 * @param envelope - the sealed envelope.
 * @param masterSecret - the master secret.
 * @returns the plaintext.
 * @throws when the envelope is malformed, tampered with, or was sealed with
 * a different master secret.
 */
export function open(envelope: SealedSecret, masterSecret: string): string {
  if (envelope === null || typeof envelope !== 'object') throw new Error('sealed secret is not an object')
  if (envelope.v !== ENVELOPE_VERSION) throw new Error(`unsupported secret envelope version: ${String(envelope.v)}`)
  if (envelope.alg !== 'aes-256-gcm') throw new Error(`unsupported secret algorithm: ${String(envelope.alg)}`)
  const salt = Buffer.from(envelope.salt, 'base64')
  const ivs = Buffer.from(envelope.iv, 'base64')
  const tagAndAuth = Buffer.from(envelope.tag, 'base64')
  const payload = Buffer.from(envelope.data, 'base64')
  if (salt.length === 0 || ivs.length !== 24 || tagAndAuth.length < 16 || payload.length < 32) {
    throw new Error('sealed secret is malformed')
  }
  const wrapIv = ivs.subarray(0, 12)
  const dataIv = ivs.subarray(12, 24)
  const wrapperTag = tagAndAuth.subarray(0, 16)
  const authTag = tagAndAuth.subarray(16)
  const wrappingKey = deriveWrappingKey(masterSecret, salt)
  const wrapper = createDecipheriv('aes-256-gcm', wrappingKey, wrapIv)
  wrapper.setAuthTag(wrapperTag)
  let dataKey: Buffer
  try {
    dataKey = Buffer.concat([wrapper.update(payload.subarray(0, 32)), wrapper.final()])
  } catch {
    throw new Error('sealed secret cannot be decrypted: wrong master secret or the file was tampered with')
  }
  const decipher = createDecipheriv('aes-256-gcm', dataKey, dataIv)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('sealed secret cannot be decrypted: wrong master secret or the file was tampered with')
  }
}

/**
 * Is a value already a sealed envelope?
 *
 * Used when reading a store that may hold either form (a store written
 * before encryption was enabled still holds plaintext).
 *
 * @param value - the value to inspect.
 * @returns true when the value is an envelope.
 */
export function isSealed(value: unknown): value is SealedSecret {
  return typeof value === 'object' && value !== null
    && typeof (value as SealedSecret).v === 'number'
    && typeof (value as SealedSecret).alg === 'string'
    && typeof (value as SealedSecret).data === 'string'
}
