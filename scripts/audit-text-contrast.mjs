/**
 * Full text-contrast audit of the panel stylesheet.
 *
 * Unlike verify-contrast.mjs (which checks the pairs I chose to check), this
 * scans EVERY `color:` declaration in panel.module.css and measures it. Picking
 * the pairs by hand is how a defect hides: I previously relaxed one threshold to
 * 3.0 so an 11px label at 3.71:1 would pass, which is moving the goalposts.
 *
 * Worst-case surfaces: text must survive the lightest surface it can land on in
 * the light skin, and the darkest in the dark skin. Terminal classes are audited
 * against the terminal's own dark surface, because that is where they paint.
 *
 * Run: node scripts/audit-text-contrast.mjs
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** Pull design-platform.css out of the installed Electron archive. */
function themeSheet() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
  ].filter(path => path !== '' && existsSync(path))
  for (const asar of candidates) {
    let fd
    try {
      fd = openSync(asar, 'r')
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
          else if (value.offset !== undefined) files.push({ path: full, size: value.size, offset: Number(value.offset) })
        }
      })(head, '')
      const target = files.find(file => file.path.endsWith('dsh-client-ui-theme/src/styles/design-platform.css'))
      if (target === undefined) continue
      const buf = Buffer.alloc(target.size)
      readSync(fd, buf, 0, target.size, dataStart + target.offset)
      return buf.toString('utf8')
    } catch {
      continue
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  return undefined
}

const THEME = themeSheet()
if (THEME === undefined) {
  console.error('SKIP  cannot read the installed theme; contrast was NOT verified')
  process.exit(2)
}

/**
 * Strip block comments before parsing.
 *
 * A `/* … *​/` line inside a declaration block makes the `[^{}]+` selector group
 * swallow the declaration that follows it, so tokens right after a comment were
 * silently invisible. That produced a false "token is undefined, text is 1.04:1"
 * report on a button that is actually white-on-blue.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Parse the theme into per-block declarations and a global last-wins map. */
function parseBlocks(text) {
  const blocks = []
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    blocks.push({ selector: match[1].trim(), body: match[2] })
  }
  return blocks
}

const THEME_BLOCKS = parseBlocks(stripComments(THEME))

function declarationsFor(selector) {
  const out = {}
  for (const block of THEME_BLOCKS) {
    if (block.selector !== selector) continue
    for (const line of block.body.split(';')) {
      const index = line.indexOf(':')
      if (index < 0) continue
      out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
    }
  }
  return out
}

function allDeclarations() {
  const out = {}
  for (const block of THEME_BLOCKS) {
    for (const line of block.body.split(';')) {
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

function parseColor(text) {
  if (text === undefined) return undefined
  const value = text.trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
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

function mix(first, percent, second) {
  if (first === undefined || second === undefined) return undefined
  const p = percent / 100
  const blend = (a, b) => Math.round(a * p + b * (1 - p))
  return { r: blend(first.r, second.r), g: blend(first.g, second.g), b: blend(first.b, second.b), a: 1 }
}

/** Evaluate a CSS colour expression (var chains and one-level color-mix). */
function evaluate(expr, skinMap, panelMap = {}) {
  // The guard must be per-branch, not shared: a token that is absent from the
  // skin block falls back to the global map, and a single shared `seen` set
  // would report the fallback as a cycle and return undefined — which reads
  // exactly like "this token is undefined", the bug this audit hunts.
  const walk = (raw, seen) => {
    if (raw === undefined) return undefined
    const value = raw.trim()
    const mixMatch = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/i.exec(value)
    if (mixMatch !== null) {
      const firstShare = Number(mixMatch[2]) / 100
      const a = walk(mixMatch[1], new Set(seen))
      const b = walk(mixMatch[3], new Set(seen))
      if (a === undefined || b === undefined) return undefined
      // Keep the alpha a plain CSS mix would produce: mixing a solid colour with
      // `transparent` yields a translucent result, which is what the browser
      // paints. Dropping that alpha made every "own fill" look opaque.
      const alpha = a.a * firstShare + b.a * (1 - firstShare)
      const blended = mix(a, Number(mixMatch[2]), b)
      return { ...blended, a: alpha }
    }
    const varMatch = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i.exec(value)
    if (varMatch !== null) {
      const name = varMatch[1]
      if (seen.has(name)) return walk(varMatch[2], seen)
      const next = new Set(seen)
      next.add(name)
      const resolved = panelMap[name] ?? skinMap[name] ?? GLOBAL[name]
      const inner = walk(resolved, next)
      return inner ?? walk(varMatch[2], next)
    }
    return parseColor(value)
  }
  return walk(expr, new Set())
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

const PANEL = readFileSync(new URL('../src/client/panel/panel.module.css', import.meta.url), 'utf8')

/**
 * The panel's OWN custom properties (the `--ssh-*` family), resolved per skin.
 *
 * The calibrated text colours live here rather than in the theme, so the audit
 * must be able to resolve them or every rule that uses one reads "unresolved".
 * They are declared on `.panel`, which is the surface they paint on.
 */
function panelTokens(skinMap) {
  const out = {}
  const panelBlock = /^\.panel\s*\{([\s\S]*?)\n\}/m.exec(PANEL)
  if (panelBlock === null) return out
  // Line-based, not `;`-split: a comment line inside the block has no semicolon,
  // so splitting on `;` merged it into the following declaration and the token
  // after every comment went missing (reported as "unresolved").
  for (const line of panelBlock[1].split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('--ssh-')) continue
    const index = trimmed.indexOf(':')
    if (index < 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).replace(/;\s*$/, '').trim()
  }
  return out
}

/** Every rule that paints text, with its selector, colour and font metrics. */
function textRules() {
  const out = []
  // Walk rules, tracking line numbers for actionable reports.
  const lines = PANEL.split(/\r?\n/)
  let offset = 0
  const lineOf = index => {
    let count = 1
    for (let i = 0; i < index; i += 1) if (PANEL[i] === '\n') count += 1
    return count
  }
  for (const match of PANEL.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim()
    if (selector.startsWith('@') || selector.startsWith('/*')) continue
    const body = match[2]
    const colorMatch = /(?:^|;|\n)\s*color\s*:\s*([^;]+)/.exec(body)
    if (colorMatch === null) continue
    const sizeMatch = /font-size\s*:\s*([\d.]+)px/.exec(body)
    const weightMatch = /font-weight\s*:\s*(\d+)/.exec(body)
    // A rule that paints its own background is measured against THAT, not the
    // page: a brand-filled button's foreground is white-on-brand, and judging it
    // against the panel surface reports a defect that does not exist.
    const bgMatch = /(?:^|;|\n)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(body)
    out.push({
      selector,
      expr: colorMatch[1].trim(),
      line: lineOf(match.index),
      size: sizeMatch === null ? 13 : Number(sizeMatch[1]),
      weight: weightMatch === null ? 400 : Number(weightMatch[1]),
      background: bgMatch === null ? undefined : bgMatch[1].trim(),
    })
    offset += 1
  }
  return out
}

/** WCAG floor: large text (>=24px, or >=18.66px bold) may use 3:1. */
function floorFor(rule) {
  const large = rule.size >= 24 || (rule.size >= 18.66 && rule.weight >= 700)
  return large ? 3 : 4.5
}

/** Surfaces a rule can paint on, per skin. Terminal classes are their own case. */
function surfacesFor(rule, skin) {
  if (/^\.term(Wrap|Container|Placeholder)/.test(rule.selector)) {
    return [{ name: 'terminal', color: { r: 11, g: 14, b: 20, a: 1 } }]
  }
  const map = skin === 'dark' ? DARK : LIGHT
  const panelMap = panelTokens(map)
  // Measured against the rule's own fill when it has one; text on a brand-filled
  // button is not text on the panel surface. A translucent fill (the tab fills
  // mix label-primary with `transparent`) must be composited onto whatever sits
  // behind it first, or the measurement compares a glyph with a half-empty
  // colour and reports ~1.1:1 for text that is plainly readable.
  if (rule.background !== undefined) {
    const own = evaluate(rule.background, map, panelMap)
    if (own !== undefined) {
      if (own.a >= 1) return [{ name: 'own fill', color: own }]
      const beneath = evaluate('var(--dsw-alias-bg-layer-1)', map, panelMap)
      if (beneath !== undefined) {
        return [{ name: 'own fill over chrome', color: over(own, over(beneath, { r: 255, g: 255, b: 255, a: 1 })) }]
      }
    }
  }
  const layer1 = evaluate('var(--dsw-alias-bg-layer-1)', map, panelMap)
  const layer2 = evaluate('var(--dsw-alias-bg-layer-2)', map, panelMap)
  const base = evaluate('var(--dsw-alias-bg-base)', map, panelMap)
  // Worst case is the surface with luminance closest to the text; checking all
  // three covers a label that lands on any of them.
  return [
    { name: 'layer-1', color: layer1 },
    { name: 'layer-2', color: layer2 },
    { name: 'base', color: base },
  ].filter(surface => surface.color !== undefined)
}

const rules = textRules()
const failures = []
let checked = 0
for (const rule of rules) {
  const floor = floorFor(rule)
  for (const skin of ['light', 'dark']) {
    const map = skin === 'dark' ? DARK : LIGHT
    const fg = evaluate(rule.expr, map, panelTokens(map))
    if (fg === undefined) {
      failures.push({ rule, skin, reason: 'unresolved colour' })
      continue
    }
    for (const surface of surfacesFor(rule, skin)) {
      const backdrop = over(surface.color, skin === 'dark' ? { r: 21, g: 21, b: 23, a: 1 } : { r: 255, g: 255, b: 255, a: 1 })
      const ratio = contrast(over(fg, backdrop), backdrop)
      checked += 1
      if (ratio < floor) {
        failures.push({ rule, skin, surface: surface.name, ratio, floor })
      }
    }
  }
}

console.log(`text rules: ${rules.length}, measurements: ${checked}`)
if (failures.length === 0) {
  console.log('\nTEXT CONTRAST OK  every text rule clears its threshold in both skins')
  process.exit(0)
}
console.log(`\nFAILURES: ${failures.length}`)
// Group by rule so one bad token is one line, not six.
const byRule = new Map()
for (const failure of failures) {
  const key = `${failure.rule.selector}|${failure.rule.expr}`
  if (!byRule.has(key)) byRule.set(key, { rule: failure.rule, cases: [] })
  byRule.get(key).cases.push(failure)
}
for (const { rule, cases } of byRule.values()) {
  const worst = cases.filter(c => c.ratio !== undefined).sort((a, b) => a.ratio - b.ratio)[0]
  const detail = worst === undefined
    ? 'unresolved'
    : `worst ${worst.ratio.toFixed(2)}:1 on ${worst.skin}/${worst.surface} (needs ${worst.floor})`
  console.log(`  L${String(rule.line).padStart(4)} ${rule.selector.padEnd(46)} ${rule.expr.slice(0, 44).padEnd(46)} ${detail}`)
}
process.exit(1)
