/**
 * Stylesheet invariants that a browser proved and a code review could miss.
 *
 * Both rules below were real defects found by rendering the panel, and both are
 * the kind that silently come back the next time someone edits the stylesheet:
 * an enumerated override list quietly falls behind, and a form control quietly
 * disagrees with the server it calls. Asserting them here keeps the lesson
 * without needing Chrome.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(resolve(root, 'src/client/panel/panel.module.css'), 'utf8')

/** Strip comments so a rule mentioned in prose is never mistaken for one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const stripped = stripComments(css)

/** Declarations only: the reduced-motion block must not match its own override. */
function declaredProperties(property: string): string[] {
  const found: string[] = []
  const re = new RegExp(`${property}\\s*:\\s*([^;{}]+);`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(stripped)) !== null) {
    const value = match[1].trim()
    if (value !== 'none' && !value.startsWith('none ')) found.push(value)
  }
  return found
}

describe('reduced-motion coverage', () => {
  it('has a prefers-reduced-motion block', () => {
    expect(stripped).toContain('@media (prefers-reduced-motion: reduce)')
  })

  /**
   * The block used to enumerate selectors, and .primaryButton declared a
   * transition while never appearing in that list — so the main call to action
   * kept animating for users who asked for less motion. A universal rule scoped
   * to .panel cannot drift; an enumerated list always can.
   */
  it('covers every animated element with a blanket rule, not a selector list', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(stripped)
    expect(block, 'reduced-motion block').not.toBeNull()
    const body = block![1]
    // Match a whole selector line, not a substring: ".panel *::before" contains
    // ".panel *" and would let a weakened rule pass this assertion.
    const selectors = body.split('{')[0].split(',').map(line => line.trim())
    expect(selectors, 'the override must apply to the whole subtree').toContain('.panel *')
    expect(selectors, 'pseudo-elements animate too').toContain('.panel *::before')
    expect(selectors, 'pseudo-elements animate too').toContain('.panel *::after')
    // !important is load-bearing: without it a more specific rule still wins and
    // the override silently stops working, which is how the original list rotted.
    expect(body).toMatch(/transition:\s*none\s*!important/)
    expect(body).toMatch(/animation:\s*none\s*!important/)
  })

  it('actually declares motion that the override has to cover', () => {
    // If this ever fails, the blanket rule is covering nothing and the test
    // above is only checking syntax.
    expect(declaredProperties('transition').length).toBeGreaterThan(0)
    expect(declaredProperties('animation').length).toBeGreaterThan(0)
  })

  it('scopes the override to .panel so host motion is untouched', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(stripped)!
    const selectors = block[1].split('{')[0]
    for (const line of selectors.split(',')) {
      const selector = line.trim()
      if (selector === '') continue
      expect(selector, 'every override selector must stay inside .panel').toMatch(/^\.panel\b/)
    }
  })
})

/**
 * The dialog surface, the hover fill, and disabled states: three defects found
 * by measuring the rendered panel, each of which a stylesheet read would miss.
 */
describe('surface and state invariants', () => {
  /**
   * `--dsw-alias-bg-overlay` is a mid grey in the dark skin (neutral-bluish-700),
   * and no calibrated text token was ever measured against it. Using it as a
   * content surface put near-white field labels on it at 3.85:1 and hints at
   * 3.24:1. The host's own dialogs use `bg-layer-2` with the prominent
   * elevation; matching them fixed the ratios (9.25 / 7.79 dark, 5.80 / 4.63
   * light).
   */
  it('never paints a content surface with the overlay token', () => {
    const offenders = [...stripped.matchAll(/background(?:-color)?:\s*var\(--dsw-alias-bg-overlay\)/g)]
    expect(offenders.length, 'bg-overlay resolves to mid grey in the dark skin').toBe(0)
  })

  it('gives the dialogs the same elevated surface as the host', () => {
    for (const name of ['.modal', '.modalCard']) {
      const rule = new RegExp(`\\${name} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(stripped)
      expect(rule, `${name} rule`).not.toBeNull()
      expect(rule![1]).toContain('var(--dsw-alias-bg-layer-2)')
      expect(rule![1]).toContain('var(--dsw-elevation-prominent)')
    }
  })

  /**
   * The theme's own hover token is a LIGHTER blue than the fill in the light
   * skin, so deriving hover from it dropped white-on-blue to 2.79:1. Deriving it
   * from the fill instead moves away from the foreground in both skins
   * (measured 6.14 light / 9.94 dark).
   */
  it('derives the primary hover fill from the fill, not from the theme hover token', () => {
    const hover = /--ssh-fill-primary-hover:\s*([^;]+);/.exec(stripped)
    expect(hover, '--ssh-fill-primary-hover declared').not.toBeNull()
    expect(hover![1]).toContain('var(--ssh-fill-primary)')
    expect(hover![1], 'button-info-hover is lighter than the fill in the light skin')
      .not.toContain('button-info-hover')
  })

  it('gives every button class a disabled state', () => {
    // Any class that advertises cursor: pointer must also say when it cannot act.
    const buttonClasses = ['primaryButton', 'ghostButton', 'secondaryButton', 'iconButton', 'connectButton', 'actionLink']
    for (const name of buttonClasses) {
      const base = new RegExp(`\\.${name} \\{([\\s\\S]*?)\\n\\}`, 'm').exec(stripped)
      expect(base, `${name} rule`).not.toBeNull()
      if (!/cursor:\s*pointer/.test(base![1])) continue
      expect(new RegExp(`\\.${name}:disabled`).test(stripped), `${name} declares cursor: pointer but no :disabled`).toBe(true)
    }
  })
})

/**
 * Async results must be announced. A screen reader otherwise says nothing when a
 * search finishes or an error appears, and the dialog's validation error is the
 * worst case: it shows up with no announcement and no focus movement.
 */
describe('live region roles', () => {
  const panelDir = resolve(root, 'src/client/panel')

  it('marks every error banner as an alert, not just a red box', () => {
    const files = readdirSync(panelDir).filter(name => name.endsWith('.tsx'))
    let banners = 0
    for (const file of files) {
      const text = readFileSync(resolve(panelDir, file), 'utf8')
      for (const match of text.matchAll(/className=\{css\.banner\} data-kind="error"([^>]*)>/g)) {
        banners += 1
        expect(match[1], `${file}: error banner without role="alert"`).toContain('role="alert"')
      }
    }
    expect(banners, 'expected the panel to show error banners somewhere').toBeGreaterThan(0)
  })

  it('marks success banners as status', () => {
    const files = readdirSync(panelDir).filter(name => name.endsWith('.tsx'))
    for (const file of files) {
      const text = readFileSync(resolve(panelDir, file), 'utf8')
      for (const match of text.matchAll(/className=\{css\.banner\} data-kind="ok"([^>]*)>/g)) {
        expect(match[1], `${file}: ok banner without role="status"`).toContain('role="status"')
      }
    }
  })

  it('announces the host form validation error', () => {
    const text = readFileSync(resolve(panelDir, 'HostFormDialog.tsx'), 'utf8')
    expect(text).toMatch(/className=\{css\.formError\} role="alert"/)
  })

  it('gives the host dialog an accessible name', () => {
    const text = readFileSync(resolve(panelDir, 'HostFormDialog.tsx'), 'utf8')
    expect(text).toContain('aria-labelledby')
    // The referenced id must exist on the heading, or the name resolves to nothing.
    const id = /aria-labelledby="([^"]+)"/.exec(text)
    expect(id, 'aria-labelledby attribute').not.toBeNull()
    expect(text).toContain(`id="${id![1]}"`)
  })
})

describe('cluster run gating', () => {
  /**
   * The server refuses a run with no aliases/environment/tags selector
   * (src/engine/cluster.ts). The button must refuse it too: an enabled Run that
   * answers with a 400 teaches the user a rule they were never told.
   */
  it('documents the selector requirement in the panel copy', () => {
    const locales = readFileSync(resolve(root, 'src/client/locales.ts'), 'utf8')
    expect(locales).toContain('cluster.needSelector')
    // Both languages must explain it; a key present in only one skin of the
    // product is an untranslated string, not a fix.
    const occurrences = locales.split('cluster.needSelector').length - 1
    expect(occurrences, 'zh and en both need the hint').toBe(2)
  })

  it('renders the hint through a class that exists in the stylesheet', () => {
    const tab = readFileSync(resolve(root, 'src/client/panel/ClusterTab.tsx'), 'utf8')
    expect(tab).toContain('css.inlineHint')
    expect(stripped).toContain('.inlineHint')
  })
})

/**
 * CSS Modules drops a rule whose selector does not exist, and a class used in
 * markup but missing from the stylesheet renders as an unstyled element with no
 * error anywhere. `.empty` is written as part of a shared selector list, so the
 * naive check for `.empty {` misses it — which is how this very file nearly
 * reported a false problem.
 */
describe('class references resolve', () => {
  it('defines every css.* class the panel components use', () => {
    const panelDir = resolve(root, 'src/client/panel')
    const defined = new Set<string>()
    // A class is defined when it appears as a selector component. The name may
    // be followed by a pseudo-class, an attribute selector, a descendant
    // combinator, or the opening brace — `.empty,` and `.empty {` are both
    // definitions, and both count.
    const missing = new Map<string, string>()
    // Strip only the selector prelude before each rule body, then collect class
    // names from it. This avoids line-start anchors, which behave differently
    // under CRLF: the stylesheet is CRLF, and `^` with the m flag matches after
    // \n, leaving the class name of the next line unreachable behind its \r.
    const preludes = [...stripped.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match => match[1])
    for (const prelude of preludes) {
      for (const match of prelude.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
        defined.add(match[1])
      }
    }
    for (const file of readdirSync(panelDir).filter(name => name.endsWith('.tsx'))) {
      const text = readFileSync(resolve(panelDir, file), 'utf8')
      // Skip import specifiers: `./xterm.css.ts` contains "css.ts", which looks
      // exactly like a class reference but is a file name.
      const withoutImports = text.replace(/^\s*import[\s\S]*?from\s+'[^']+'\s*$/gm, '')
      for (const match of withoutImports.matchAll(/css\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = match[1]
        if (defined.has(name)) continue
        if (!missing.has(name)) missing.set(name, file)
      }
    }
    const unresolved = [...missing.entries()].map(([name, file]) => `${name} (used in ${file})`)
    expect(unresolved, 'css.* classes used in markup but never defined in the stylesheet').toEqual([])
  })
})