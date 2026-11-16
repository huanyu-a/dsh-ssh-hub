/**
 * Packaging guard: pack the tarball, then verify that what the tarball
 * contains is byte-identical to what is on disk.
 *
 * Why this exists: `npm run build` only writes `lib/`. The installer copies
 * a TARBALL, so a green build with a stale tarball means the profile
 * installs the old code and everything looks fine — the classic "same
 * version reinstall fakes green" failure. The check here compares the
 * SHA-256 of every shipped file inside the tarball against the file on
 * disk, so a stale artifact fails the build instead of the deployment.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTarball } from './tarball-reader.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = join(root, 'artifacts')
// npm pack does not create the destination directory.
if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true })

/** The SHA-256 of a buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** The files the package ships, as declared by package.json "files". */
function shippedFiles() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const patterns = manifest.files ?? []
  const roots = patterns.map(pattern => pattern.replace(/\/\*\*?.*$/, ''))
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).replaceAll('\\', '/')
      const underAPattern = roots.some(pattern => rel === pattern || rel.startsWith(`${pattern}/`))
      if (!underAPattern) continue
      if (entry.isFile()) found.push(rel)
      else if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return found.sort()
}

// 1. Pack.
//
// `npm` on Windows is a shell shim (npm.cmd / npm.ps1), so execFileSync
// cannot find it by bare name. Resolve npm's JS entry point from the
// well-known layouts; fall back to a shelled `npm` only when none exists.
const npmCandidates = [
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
]
const npmCli = npmCandidates.find(candidate => existsSync(candidate))
const packOutput = npmCli !== undefined
  ? execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', artifactsDir, '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  : execFileSync('npm', ['pack', '--pack-destination', artifactsDir, '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  })
const packInfo = JSON.parse(packOutput)
const tarball = join(artifactsDir, packInfo[0].filename)
console.log(`packed ${packInfo[0].filename} (${packInfo[0].entryCount} entries)`)

// 2. Read the tarball back and compare each shipped file against the disk.
const entries = readTarball(readFileSync(tarball))
const packed = new Map(
  entries.filter(entry => !entry.directory).map(entry => [entry.path, entry.data]),
)

const onDisk = shippedFiles()
const missing = []
const mismatched = []
for (const rel of onDisk) {
  const data = packed.get(rel)
  if (data === undefined) {
    missing.push(rel)
    continue
  }
  if (sha256(data) !== sha256(readFileSync(join(root, rel)))) {
    mismatched.push(rel)
  }
}

if (missing.length > 0 || mismatched.length > 0) {
  console.error('packaging check FAILED')
  if (missing.length > 0) console.error(`  missing from tarball: ${missing.join(', ')}`)
  if (mismatched.length > 0) console.error(`  content differs from disk: ${mismatched.join(', ')}`)
  process.exit(1)
}

// 3. The tarball must carry the built bundles, and they must not be stubs.
for (const required of ['lib/index.js', 'lib/client.js']) {
  const data = packed.get(required)
  if (data === undefined) {
    console.error(`packaging check FAILED: ${required} is not in the tarball`)
    process.exit(1)
  }
  if (data.length < 1000) {
    console.error(`packaging check FAILED: ${required} is suspiciously small (${data.length} bytes) — the build did not run`)
    process.exit(1)
  }
}

console.log(`packaging check OK: ${onDisk.length} files match the tarball`)
