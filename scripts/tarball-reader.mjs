/**
 * Minimal tar reader, just enough to verify a packed npm tarball.
 *
 * Why not a dependency: the pack guard must work in a repo with no extra
 * tooling, and it must not shell out to `tar` — Git Bash, cmd, and Windows'
 * bsdtar disagree about flags. A tar archive is 512-byte header blocks
 * followed by file data padded to 512 bytes, which is small enough to read
 * directly and is exactly the subset npm produces.
 */

import { gunzipSync } from 'node:zlib'

/**
 * Read every regular file from a gzipped tarball.
 *
 * @param {Buffer} tarball - the gzipped tarball bytes.
 * @returns {Array<{ path: string, data: Buffer, directory: boolean }>} the entries.
 */
export function readTarball(tarball) {
  const raw = gunzipSync(tarball)
  /** @type {Array<{ path: string, data: Buffer, directory: boolean }>} */
  const entries = []
  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // An all-zero block marks the end of the archive.
    if (header.every(byte => byte === 0)) break

    const name = readString(header, 0, 100)
    const sizeField = readString(header, 124, 12).trim()
    // The size is octal, padded with spaces or NULs.
    const size = Number.parseInt(sizeField.replace(/[^0-7]/g, ''), 8)
    // A prefix field (ustar) extends the name past 100 bytes.
    const prefix = readString(header, 345, 155)
    const typeFlag = String.fromCharCode(header[156] ?? 0)
    const fullPath = prefix === '' ? name : `${prefix}/${name}`

    const dataStart = offset + 512
    const dataSize = Number.isFinite(size) ? size : 0
    const data = raw.subarray(dataStart, dataStart + dataSize)

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      entries.push({ path: normalize(fullPath), data: Buffer.from(data), directory: false })
    } else if (typeFlag === '5') {
      entries.push({ path: normalize(fullPath), data: Buffer.alloc(0), directory: true })
    }

    // Advance past the header plus the data, rounded up to a 512 boundary.
    const padded = Math.ceil(dataSize / 512) * 512
    offset = dataStart + padded
  }
  return entries
}

/** Read a NUL-terminated string field. */
function readString(block, start, length) {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return (end === -1 ? field : field.subarray(0, end)).toString('utf8')
}

/** Strip the `package/` root npm always prepends. */
function normalize(path) {
  return path.replace(/^\.\//, '').replace(/^package\//, '')
}