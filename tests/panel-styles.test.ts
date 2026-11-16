/**
 * Stylesheet invariants that a browser proved and a code review could miss.
 *
 * Both rules below were real defects found by rendering the panel, and both are
 * the kind that silently come back the next time someone edits the stylesheet:
 * an enumerated override list quietly falls behind, and a form control quietly
 * disagrees with the server it calls. Asserting them here keeps the lesson
 * without needing Chrome.
 */
import { readFileSync } from 'node:fs'
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