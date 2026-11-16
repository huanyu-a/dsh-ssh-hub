/**
 * WCAG contrast audit for the panel's own painting, in BOTH skins.
 *
 * Reads the themed colours out of the installed DSH theme stylesheet (the
 * authority for what a token really resolves to) and measures the exact pairs
 * this panel paints, including its color-mix fills. Two real defects were found
 * this way and neither was visible by reading the CSS:
 *
 *   1. bg-base / bg-layer-1 / bg-layer-2 all resolve to pure white in the light
 *      skin, so an active tab filled with bg-layer-2 was invisible. The fill is
 *      now a label-primary mix, which steps visibly on white and near-black.
 *   2. state-success (rgb(34,197,94)) as small text measures 2.28:1 on white.
 *      State hues are built for dots and fills; as glyphs they are pulled toward
 *      label-primary, which puts LIVE at 5.18:1 (light) / 9.21:1 (dark).
 *
 * Run: node scripts/verify-contrast.mjs
 * Exits non-zero on any pair below its threshold in either skin.
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate the installed DSH theme stylesheet.
 *
 * The shipped theme is the only authority for what `--dsw-alias-*` resolves to,
 * and it lives inside the Electron archive. When the archive cannot be read
 * (a source checkout, a future layout), the audit reports that it did not run
 * rather than silently passing.
 */
function findThemeSheet() {
  const candidates = [
    'C:/Users/WIN11/AppData/Local/Programs/DeepSeek Harness/resources/app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
  ].filter(path => path !== '' && existsSync(path))
  for (const asar of candidates) {
    const text = extractFromAsar(asar)
    if (text !== undefined) return text
  }
  return undefined
}

/** Pull design-platform.css out of an asar archive. */
function extractFromAsar(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const pre = Buffer.alloc(16)
    readSync(fd, pre, 0, 16, 0)
    const headerSize = pre.readUInt32LE(4)
    const jsonLen = pre.readUInt32LE(12)
    const json = Buffer.alloc(jsonLen)
    readSync(fd, json, 0, jsonLen, 16)
    const head = JSON.parse(json.toString('utf8'))
    const dataStart = 8 + headerSize
    const files = []
    ;(function walk(node, prefix) {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`
        if (value.files !== undefined) walk(value, full)
        // Unpacked entries live outside the archive and carry no offset.
        else if (value.offset !== undefined) files.push({ path: full, size: value.size, offset: Number(value.offset) })
      }
    })(head, '')
    const target = files.find(file => file.path.endsWith('dsh-client-ui-theme/src/styles/design-platform.css'))
    if (target === undefined) return undefined
    const buf = Buffer.alloc(target.size)
    readSync(fd, buf, 0, target.size, dataStart + target.offset)
    return buf.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const CSS = findThemeSheet()
if (CSS === undefined) {
  console.error('SKIP  cannot read the installed DSH theme stylesheet, so contrast was NOT verified')
  console.error('      (this is a failure to verify, not a pass)')
  process.exit(2)
}

function declarationsFor(selector) {
  const out = {}
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].trim() !== selector) continue
    for (const line of match[2].split(';')) {
      const index = line.indexOf(':')
      if (index < 0) continue
      out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
    }
  }
  return out
}

function allDeclarations() {
  const out = {}
  for (const match of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const line of match[2].split(';')) {
      const index = line.indexOf(':')
      if (index < 0) continue
      out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
    }
  }
  return out
}

const LIGHT = declarationsFor('body')
const DARK = declarationsFor('body[data-ds-dark-theme]')
const GLOBAL = allDeclarations()

function resolveFor(token, skinMap) {
  const seen = new Set()
  const walk = name => {
    if (seen.has(name)) return undefined
    seen.add(name)
    const value = skinMap[name] ?? GLOBAL[name]
    if (value === undefined) return undefined
    const ref = /var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]+))?\)/.exec(value)
    if (ref === null) return value
    return walk(ref[1]) ?? (ref[2] !== undefined ? ref[2].trim() : undefined)
  }
  return walk(token)
}

function parseColor(text) {
  if (text === undefined) return undefined
  const value = text.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex !== null) {
    const n = Number.parseInt(hex[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(value)
  if (rgb !== null) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) }
  }
  return undefined
}

/** Evaluate color-mix(in srgb, A p%, B) with resolved colours. */
function mix(first, percent, second) {
  if (first === undefined || second === undefined) return undefined
  const p = percent / 100
  const blend = (a, b) => Math.round(a * p + b * (1 - p))
  return { r: blend(first.r, second.r), g: blend(first.g, second.g), b: blend(first.b, second.b), a: 1 }
}

function over(front, back) {
  if (front === undefined) return back
  if (front.a >= 1) return front
  const a = front.a
  return {
    r: Math.round(front.r * a + back.r * (1 - a)),
    g: Math.round(front.g * a + back.g * (1 - a)),
    b: Math.round(front.b * a + back.b * (1 - a)),
    a: 1,
  }
}

function luminance({ r, g, b }) {
  const channel = value => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function token(name, skin) {
  return parseColor(resolveFor(name, skin === 'dark' ? DARK : LIGHT))
}

/** Backdrop the chrome paints on: bg-layer-1 composited over the page. */
function chromeBackdrop(skin) {
  const page = skin === 'dark' ? { r: 21, g: 21, b: 23, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
  return over(token('--dsw-alias-bg-layer-1', skin), page)
}

/** The tab fill mixes: label-primary at 5% / 10% over the chrome. */
function tabFill(skin, percent) {
  return mix(token('--dsw-alias-label-primary', skin), percent, chromeBackdrop(skin))
}

let failures = 0
const rows = []
for (const skin of ['light', 'dark']) {
  const chrome = chromeBackdrop(skin)
  const hover = tabFill(skin, 5)
  const active = tabFill(skin, 10)
  const labelPrimary = token('--dsw-alias-label-primary', skin)
  const labelSecondary = token('--dsw-alias-label-secondary', skin)
  const labelTertiary = token('--dsw-alias-label-tertiary', skin)
  const successText = mix(token('--dsw-alias-state-success-primary', skin), 60, labelPrimary)
  const errorText = mix(token('--dsw-alias-state-error-primary', skin), 60, labelPrimary)

  const checks = [
    ['title / active tab label', labelPrimary, chrome, 4.5],
    ['inactive tab label', labelSecondary, chrome, 4.5],
    ['active tab label on active fill', labelPrimary, active, 4.5],
    ['hover tab label on hover fill', labelSecondary, hover, 4.5],
    ['external state (default) on chrome', labelTertiary, chrome, 3.0],
    ['external state LIVE text', successText, chrome, 4.5],
    ['external state DEAD text', errorText, chrome, 4.5],
    ['active tab underline', token('--dsw-alias-brand-primary', skin), active, 3.0],
  ]
  for (const [label, fg, bg, floor] of checks) {
    if (fg === undefined || bg === undefined) {
      rows.push(`${skin.padEnd(5)} ${label.padEnd(38)}   ???  unresolved`)
      failures += 1
      continue
    }
    const ratio = contrast(over(fg, bg), bg)
    const ok = ratio >= floor
    if (!ok) failures += 1
    rows.push(`${skin.padEnd(5)} ${label.padEnd(38)} ${ratio.toFixed(2).padStart(6)}  ${ok ? 'OK' : 'FAIL'} (>=${floor})`)
  }
}

console.log('skin  pair                                    ratio  verdict')
for (const row of rows) console.log(row)
console.log(failures === 0 ? '\nCONTRAST OK  every painted pair clears its threshold in both skins' : `\nCONTRAST FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
