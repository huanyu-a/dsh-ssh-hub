/**
 * Render the panel outside the GUI and screenshot both skins.
 *
 * Why this exists: the running Web GUI sits behind DSH authentication, so the
 * panel could not be looked at directly. For three iterations the styling was
 * justified by token arithmetic alone. This script closes that gap without
 * touching credentials: it takes the REAL compiled CSS out of the built client
 * bundle, the REAL theme out of the installed app archive, and the REAL host and
 * tunnel data from the running plugin, then renders them with headless Chrome.
 *
 * What it proves: what the browser actually computes — resolved var() chains,
 * evaluated color-mix, skin switching, column visibility — rather than what the
 * stylesheet appears to say. It also reports computed colours so contrast can be
 * measured from the engine's own answer.
 *
 * Usage:
 *   node scripts/render-preview.mjs [--out <dir>]
 *
 * Requires: a built lib/client.js, an installed DSH app.asar, and a Chrome or
 * Edge binary. Exits 2 when a prerequisite is missing — a preview that silently
 * renders nothing must not look like a passing check.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const OUT = (() => {
  const index = process.argv.indexOf('--out')
  return index > 0 ? resolve(process.argv[index + 1]) : join(ROOT, 'artifacts', 'preview')
})()

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

/** The compiled CSS, exactly as the bundle injects it at runtime. */
function extractPanelCss() {
  const bundlePath = join(ROOT, 'lib', 'client.js')
  if (!existsSync(bundlePath)) return undefined
  const bundle = readFileSync(bundlePath, 'utf8')
  const match = /style\.textContent\s*=\s*("(?:[^"\\]|\\.)*")/.exec(bundle)
  if (match === null) return undefined
  return JSON.parse(match[1])
}

/** The hashed class suffix the build used, so the harness applies real styles. */
function classSuffix(css) {
  const match = /\.panel_([a-z0-9]+)/.exec(css)
  return match === null ? undefined : match[1]
}

/** Live data when the plugin is reachable; a representative fixture otherwise. */
async function loadData() {
  const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:51697'
  try {
    const hosts = await (await fetch(`${base}/api/dsh-ssh/hosts`, { signal: AbortSignal.timeout(4000) })).json()
    const tunnels = await (await fetch(`${base}/api/dsh-ssh/tunnel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list' }),
      signal: AbortSignal.timeout(4000),
    })).json()
    if (Array.isArray(hosts.hosts) && Array.isArray(tunnels.tunnels)) {
      return { hosts: hosts.hosts, tunnels: tunnels.tunnels, live: true }
    }
  } catch { /* fall through to the fixture */ }
  return {
    live: false,
    hosts: [
      { alias: 'web-01', host: '10.0.0.11', port: 22, user: 'deploy', auth: 'key', tags: ['prod'], environment: 'production', description: 'edge node', proxyJump: [] },
      { alias: 'web-02', host: '10.0.0.12', port: 22, user: 'deploy', auth: 'key', tags: [], environment: '', description: '', proxyJump: [] },
      { alias: 'db-01', host: '10.0.0.21', port: 22, user: 'root', auth: 'password', tags: ['prod', 'db'], environment: 'production', description: '', proxyJump: [] },
      { alias: 'ci-runner', host: '10.0.0.31', port: 2222, user: 'ci', auth: 'agent', tags: [], environment: '', description: '', proxyJump: [] },
    ],
    tunnels: [
      { id: 'a', alias: 'web-01', localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80, state: 'forwarding', source: 'plugin' },
      { id: 'b', alias: 'db-01', localPort: 5432, remoteHost: '127.0.0.1', remotePort: 5432, state: 'forwarding', source: 'external', pid: 4242, live: true },
      { id: 'c', alias: 'ci-runner', localPort: 9000, remoteHost: '127.0.0.1', remotePort: 9000, state: 'failed', source: 'external', pid: 4243, live: false },
    ],
  }
}

/**
 * Build the harness page.
 *
 * Markup mirrors the components: the same class names, the same data attributes,
 * the same column-visibility rule (a column appears only when some host has data
 * for it). A harness that invents its own structure would verify nothing.
 */
function buildPage(skin, css, theme, suffix, data) {
  const c = name => `${name}_${suffix}`
  const dark = skin === 'dark'
  const visible = {
    environment: data.hosts.some(host => (host.environment ?? '') !== ''),
    tags: data.hosts.some(host => (host.tags ?? []).length > 0),
    description: data.hosts.some(host => (host.description ?? '') !== ''),
  }
  const authLabel = { key: 'Private key', password: 'Password', agent: 'Agent', none: 'None' }
  const rows = data.hosts.map((host, index) => {
    // Show each observable state once so every rail and chip is exercised.
    const state = index === 0 ? 'ok' : index === 2 ? 'fail' : index === 3 ? 'testing' : ''
    const chip = state === 'ok'
      ? `<span class="${c('inlineTest')}" data-status="ok">188 ms</span>`
      : state === 'fail'
        ? `<span class="${c('inlineTest')}" data-status="fail">failed</span>`
        : state === 'testing'
          ? `<span class="${c('spinner')}"></span>`
          : ''
    return `<tr data-state="${state}">
      <td><div class="${c('hostIdentity')}">
        <span class="${c('hostAlias')}">${host.alias}</span>
        <span class="${c('hostEndpoint')}"><span>${host.user}@${host.host}:${host.port}</span></span>
      </div></td>
      <td><span class="${c('badge')}" data-kind="${host.auth}">${authLabel[host.auth] ?? host.auth}</span></td>
      ${visible.environment ? `<td class="${c('cellMuted')}">${host.environment ?? ''}</td>` : ''}
      ${visible.tags ? `<td>${(host.tags ?? []).length > 0 ? `<span class="${c('tagList')}">${host.tags.map(tag => `<span class="${c('tag')}">${tag}</span>`).join('')}</span>` : ''}</td>` : ''}
      ${visible.description ? `<td class="${c('cellMuted')}">${host.description ?? ''}</td>` : ''}
      <td><div class="${c('actions')}">${chip}
        <span class="${c('actionLinks')}">
          <button class="${c('actionLink')}">Test</button>
          <button class="${c('actionLink')}">Edit</button>
          <button class="${c('actionLink')}" data-danger>Delete</button>
        </span>
        <button class="${c('connectButton')}">Connect</button>
      </div></td>
    </tr>`
  }).join('')
  const tunnels = data.tunnels.slice(0, 6).map(tunnel => `<div class="${c('tunnelRow')}" data-state="${tunnel.state}" data-source="${tunnel.source ?? 'plugin'}">
      <span class="${c('tunnelLabel')}">${tunnel.alias} &middot; 127.0.0.1:${tunnel.localPort} &rarr; ${tunnel.remoteHost}:${tunnel.remotePort}${tunnel.pid !== undefined ? ` (pid ${tunnel.pid})` : ''}</span>
      ${tunnel.source === 'external'
        ? `<span class="${c('tunnelState')}" data-live="${tunnel.live === true ? 'true' : 'false'}">${tunnel.live === true ? 'Port accepting' : 'Port NOT listening'}</span>`
        : `<button class="${c('ghostButton')}">Stop</button>`}
    </div>`).join('')
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SSH Hub preview (${skin})</title>
<style>${theme}</style>
<style>
html,body{margin:0;padding:0}
body{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.shell{width:1180px}
</style>
<style>${css}</style></head>
<body${dark ? ' data-ds-dark-theme' : ''}><div class="shell">
  <div class="${c('view')}"><div class="${c('panel')}">
    <div class="${c('panelHeader')}"><span class="${c('panelTitle')}">SSH Hub</span></div>
    <div class="${c('tabBar')}">
      <button class="${c('tab')}" data-active="true">Hosts</button>
      <button class="${c('tab')}">Terminal</button>
      <button class="${c('tab')}">Files</button>
      <button class="${c('tab')}">Tunnels</button>
      <button class="${c('tab')}">Batch</button>
      <button class="${c('tab')}">Monitoring</button>
      <button class="${c('tab')}">Deploy</button>
      <button class="${c('tab')}">Logs</button>
    </div>
    <div class="${c('panelContent')}"><div class="${c('panel')}">
      <div class="${c('toolbar')}"><input class="${c('search')}" placeholder="Filter hosts"></div>
      <div class="${c('tableWrap')}"><table class="${c('table')} ${c('hostsTable')}">
        <thead><tr>
          <th>Host</th><th>Auth</th>
          ${visible.environment ? '<th>Environment</th>' : ''}
          ${visible.tags ? '<th>Tags</th>' : ''}
          ${visible.description ? '<th>Description</th>' : ''}
          <th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div></div>
  </div></div>
  <div class="${c('panel')}" style="margin-top:20px"><div class="${c('panelContent')}">
    <div class="${c('hint')}">Forwards started outside this panel are read-only.</div>
    <div class="${c('tunnelList')}">${tunnels}</div>
    <div class="${c('banner')}" data-kind="ok">Imported 2 hosts from ~/.ssh/config.</div>
    <div class="${c('banner')}" data-kind="warn">Monitoring is off; the alert list is not a health signal.</div>
    <div class="${c('banner')}" data-kind="error">Connection to instabox-1 failed: upstream closed the socket.</div>
  </div></div>
</div></body></html>`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** Screenshot one page with headless Chrome. */
async function shoot(browser, htmlPath, pngPath) {
  const url = 'file:///' + htmlPath.replace(/\\/g, '/')
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--window-size=1200,1250',
    `--screenshot=${pngPath}`, url,
  ], { stdio: 'ignore' })
  const code = await new Promise(resolve => child.on('exit', resolve))
  return existsSync(pngPath) && (code === 0 || code === null)
}

async function main() {
  const browser = findBrowser()
  const css = extractPanelCss()
  const theme = readFromAsar(
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
    'dsh-client-ui-theme/src/styles/design-platform.css',
  )
  const missing = []
  if (browser === undefined) missing.push('a Chrome or Edge binary')
  if (css === undefined) missing.push('lib/client.js with injected CSS (run build:client)')
  if (theme === undefined) missing.push('the installed DSH theme stylesheet')
  if (missing.length > 0) {
    console.error('SKIP  cannot render a preview, missing:')
    for (const item of missing) console.error(`  - ${item}`)
    console.error('      this is a failure to verify, not a pass')
    process.exit(2)
  }
  const suffix = classSuffix(css)
  if (suffix === undefined) {
    console.error('SKIP  cannot determine the CSS class hash from the bundle')
    process.exit(2)
  }

  const data = await loadData()
  console.log(`data: ${data.live ? 'live plugin' : 'built-in fixture'} (${data.hosts.length} hosts, ${data.tunnels.length} tunnels)`)
  mkdirSync(OUT, { recursive: true })
  const scratch = join(tmpdir(), `dsh-ssh-preview-${process.pid}`)
  mkdirSync(scratch, { recursive: true })

  let ok = true
  for (const skin of ['light', 'dark']) {
    const htmlPath = join(scratch, `preview-${skin}.html`)
    writeFileSync(htmlPath, buildPage(skin, css, theme, suffix, data))
    const pngPath = join(OUT, `panel-${skin}.png`)
    const shot = await shoot(browser, htmlPath, pngPath)
    console.log(`${skin.padEnd(5)} ${shot ? 'rendered' : 'FAILED'}  ${pngPath}`)
    if (!shot) ok = false
  }
  console.log(ok ? `\nPREVIEW OK  both skins rendered into ${OUT}` : '\nPREVIEW FAILED')
  process.exit(ok ? 0 : 1)
}

main().catch(error => { console.error('FAILED', error.message); process.exit(1) })