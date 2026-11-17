/**
 * Render every panel view outside the GUI and screenshot both skins.
 *
 * Why this exists: the running Web GUI sits behind DSH authentication, so the
 * panel could not be looked at directly. For several iterations the styling was
 * justified by token arithmetic alone — and arithmetic cannot see a table whose
 * columns are all empty, or a button that resolves its fill token to nothing.
 *
 * How it works, without touching any credential:
 *   - the ACTUAL components are bundled with esbuild (scripts/harness.mjs),
 *   - scoped with the SAME CSS-module plugin the shipping build uses,
 *   - fed the theme from the installed app.asar,
 *   - and served next to a proxy that forwards /api/dsh-ssh to the running
 *     plugin, so the components run their real request paths.
 *
 * Usage:
 *   node scripts/render-preview.mjs [--out <dir>]
 *
 * Exits 2 (SKIP) when a prerequisite is missing, and 1 when a rendered view is
 * blank or reports a crash. A preview that renders nothing must never look like
 * a pass: that is exactly how the earlier harness produced confident, worthless
 * screenshots.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { bundleHarness } from './harness.mjs'
import { writeHarnessPage } from './harness-page.mjs'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT = (() => {
  const index = process.argv.indexOf('--out')
  return index > 0 ? resolve(process.argv[index + 1]) : join(ROOT, 'artifacts', 'preview')
})()

/** Every view the harness can mount, with the height it needs to lay out. */
const VIEWS = [
  { id: 'hosts', height: 1100 },
  { id: 'terminal', height: 1100 },
  { id: 'files', height: 1100 },
  { id: 'tunnels', height: 1100 },
  { id: 'cluster', height: 1100 },
  { id: 'deploy', height: 1100 },
  { id: 'logs', height: 1100 },
  { id: 'dialog', height: 1400 },
  { id: 'tunnel-edit', height: 1200 },
  { id: 'tunnel-remark', height: 1000 },
  // The whole panel shell: its own header and tab strip, which the per-tab views
  // do not exercise because they render a simplified header.
  { id: 'shell', height: 1100 },
]

const SKINS = ['light', 'dark']

/** Candidate browser binaries, in preference order. */
function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
  return candidates.find(path => existsSync(path))
}

/** Pull a file's bytes out of an Electron asar archive. */
function readFromAsar(archive, suffix) {
  let fd
  try {
    fd = openSync(archive, 'r')
    const pre = Buffer.alloc(16)
    readSync(fd, pre, 0, 16, 0)
    const headerSize = pre.readUInt32LE(4)
    const jsonLength = pre.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    const header = JSON.parse(json.toString('utf8'))
    const dataStart = 8 + headerSize
    const files = []
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`
        if (value.files !== undefined) walk(value, full)
        // Unpacked entries live outside the archive and carry no offset.
        else if (value.offset !== undefined) files.push({ path: full, size: value.size, offset: Number(value.offset) })
      }
    }
    walk(header, '')
    const target = files.find(file => file.path.endsWith(suffix))
    if (target === undefined) return undefined
    const buffer = Buffer.alloc(target.size)
    readSync(fd, buffer, 0, target.size, dataStart + target.offset)
    return buffer.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** Screenshot one view, returning the file size so a blank page can be spotted. */
async function shoot(browser, url, pngPath, height) {
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', `--window-size=1200,${height}`,
    '--virtual-time-budget=7000', `--screenshot=${pngPath}`, url,
  ], { stdio: 'ignore' })
  const code = await new Promise(resolve => child.on('exit', resolve))
  if (!existsSync(pngPath)) return { ok: false, bytes: 0, code }
  return { ok: code === 0 || code === null, bytes: readFileSync(pngPath).length, code }
}

/**
 * Read what the harness rendered, so a crash is reported as a crash.
 *
 * A blank screenshot is ambiguous: it could mean "this view is empty by design".
 * Asking the page settles it.
 */
async function inspectPage(browser, url) {
  const port = 9412 + Math.floor(Math.random() * 80)
  const profile = join(tmpdir(), `dsh-ssh-inspect-${process.pid}`)
  const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' })
  let ready = false
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ready = true; break } catch { /* starting */ }
  }
  if (!ready) { chrome.kill(); return { error: 'CDP never came up' } }
  try {
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    let id = 0
    const pending = new Map()
    ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    }
    const send = (method, params = {}) => new Promise(done => {
      id += 1
      pending.set(id, done)
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    await sleep(3500)
    const expression = `(() => {
      const crash = document.getElementById('harness-crash')
      const root = document.getElementById('root')
      return JSON.stringify({
        crash: crash ? crash.textContent : null,
        html: root ? root.innerHTML.length : 0,
        text: root ? root.innerText.trim().length : 0,
        hashed: document.querySelectorAll('[class*="_"]').length,
        undefinedClasses: document.querySelectorAll('[class*="undefined"]').length,
      })
    })()`
    const result = await send('Runtime.evaluate', { expression, returnByValue: true })
    ws.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
    return JSON.parse(result.result?.result?.value ?? '{}')
  } finally {
    chrome.kill()
  }
}

async function main() {
  const browser = findBrowser()
  const theme = readFromAsar(
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
    'dsh-client-ui-theme/src/styles/design-platform.css',
  )
  const missing = []
  if (browser === undefined) missing.push('a Chrome or Edge binary')
  if (theme === undefined) missing.push('the installed DSH theme stylesheet')
  if (!existsSync(join(ROOT, 'lib', 'client.js'))) missing.push('a built bundle (run build:client)')
  if (missing.length > 0) {
    console.error('SKIP  cannot render a preview, missing:')
    for (const item of missing) console.error(`  - ${item}`)
    console.error('      this is a failure to verify, not a pass')
    process.exit(2)
  }

  mkdirSync(OUT, { recursive: true })
  // The harness and its page are written to the artifacts directory so the
  // proxy can serve them; both are regenerated on every run.
  console.log('bundling the real components...')
  writeFileSync(join(OUT, 'harness.js'), await bundleHarness())
  if (!writeHarnessPage(ROOT, OUT)) {
    console.error('SKIP  could not write the harness page (theme missing)')
    process.exit(2)
  }

  const port = Number(process.env.HARNESS_PORT ?? 5179)
  const server = spawn(process.execPath, [join(ROOT, 'scripts', 'harness-server.mjs'), OUT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HARNESS_PORT: String(port) },
  })
  const serverLog = []
  server.stdout.on('data', chunk => serverLog.push(String(chunk)))
  server.stderr.on('data', chunk => serverLog.push(String(chunk)))

  let connected = false
  for (let i = 0; i < 40; i += 1) {
    await sleep(250)
    try { await fetch(`http://127.0.0.1:${port}/api/dsh-ssh/hosts`, { signal: AbortSignal.timeout(1500) }); connected = true; break } catch { /* starting */ }
  }
  if (!connected) {
    server.kill()
    console.error('SKIP  the harness proxy never came up')
    for (const line of serverLog.slice(0, 6)) console.error(`      ${line.trim()}`)
    process.exit(2)
  }

  let failures = 0
  try {
    for (const skin of SKINS) {
      for (const view of VIEWS) {
        const url = `http://127.0.0.1:${port}/?tab=${view.id}&skin=${skin}`
        const pngPath = join(OUT, `real-${view.id}-${skin}.png`)
        const shot = await shoot(browser, url, pngPath, view.height)
        // A harness crash renders text, so a crashed view can still be large.
        // Check both the file and what the page actually produced.
        const page = await inspectPage(browser, url)
        const problems = []
        if (!shot.ok) problems.push('screenshot failed')
        if (shot.bytes < 3000) problems.push(`only ${shot.bytes} bytes (blank)`)
        if (page.crash !== null && page.crash !== undefined) problems.push(`crash: ${String(page.crash).slice(0, 120)}`)
        if (page.undefinedClasses > 0) problems.push(`${page.undefinedClasses} elements have "undefined" as a class`)
        if (page.hashed === 0) problems.push('no scoped classes were applied')
        const verdict = problems.length === 0 ? 'ok' : problems.join('; ')
        if (problems.length > 0) failures += 1
        console.log(`  ${skin.padEnd(5)} ${view.id.padEnd(9)} ${String(Math.round(shot.bytes / 1024)).padStart(4)} KB  ${verdict}`)
      }
    }
  } finally {
    server.kill()
  }

  console.log(failures === 0
    ? `\nPREVIEW OK  ${VIEWS.length * SKINS.length} views rendered into ${OUT}`
    : `\nPREVIEW FAILED  ${failures} view(s) blank or broken`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => { console.error('FAILED', error.message); process.exit(1) })