/**
 * Write the harness HTML that mounts the real components.
 *
 * The CSS is the compiled stylesheet taken from the shipped bundle, so the
 * scoped class names match the ones the components import at build time. Theme
 * tokens come from the installed app archive. Nothing is re-derived here.
 */

import { closeSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Pull a file out of an Electron asar archive. */
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

/**
 * The harness bundle injects the scoped stylesheet itself, through the same
 * CSS-module plugin the shipping build uses. Injecting a second copy here would
 * duplicate every rule for no benefit, so the page only supplies the theme.
 */

/**
 * Build the page.
 *
 * `skin` and `tab` come from the query string so one file serves every
 * combination; the runner drives them by URL rather than writing a file per case.
 */
/**
 * The theme is fourteen stylesheets, not one.
 *
 * The package imports each of them from JS rather than via @import, so injecting
 * only design-platform.css left the harness without the shadow tokens (declared
 * in gradient-shadow-text.css), the focus treatment, or the scrollbar tokens.
 * Anything measured against those would have been measuring a page the GUI never
 * renders. Order matters: base first, then the alias layer, then the decorative
 * and interactive layers that build on it.
 */
const THEME_ORDER = [
  'src/styles/base.css',
  'src/styles/design-platform.css',
  'src/styles/gradient-shadow-text.css',
  'src/styles/focus.css',
  'src/styles/scrollbar.css',
  'src/styles/corner-shape.css',
  'src/styles/onboarding.css',
  'src/styles/shiki.css',
  'src/styles/brand-font.css',
]

/** Every stylesheet the theme package ships, in load order. */
function readTheme(archive) {
  const parts = []
  for (const name of THEME_ORDER) {
    const text = readFromAsar(archive, `dsh-client-ui-theme/${name}`)
    if (text !== undefined) parts.push(`/* ==== ${name} ==== */\n${text}`)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

export function writeHarnessPage(root, outDir) {
  const theme = readTheme(join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'))
  if (theme === undefined) return false

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>SSH Hub harness</title>
<style>${theme}</style>
<style>
html, body { margin: 0; padding: 0; }
body {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
}
/* The panel must be able to shrink with the viewport, otherwise a fixed width
   hides the product's own responsive behaviour: a hard 1180px root made an
   885px window report a horizontal overflow that the real panel does not have.
   The runner passes an explicit width when it wants a fixed one. */
#root { width: 100%; max-width: 1180px; min-height: 900px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
// The runner sets these before any module runs, so the harness can pick a skin
// and a tab per page load without rebuilding the bundle.
(function () {
  var params = new URLSearchParams(location.search)
  if (params.get('skin') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  if (params.get('narrow') === '1') { document.getElementById('root').style.maxWidth = '720px' }
})()
</script>
<script src="./harness.js"></script>
</body></html>`
  writeFileSync(join(outDir, 'index.html'), html)
  return true
}