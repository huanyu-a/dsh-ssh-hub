/**
 * The panel's tab table: every tab is reachable and labelled.
 *
 * The regression this covers actually happened during development: the deploy
 * and logs components were written, their routes were live, their locale keys
 * were added — and nothing rendered them, because the tab list and the render
 * switch were separate lists that both looked complete. Keeping the table in
 * one imported module and asserting it here makes that class of omission
 * visible without a browser.
 */
import { describe, expect, it } from 'vitest'
import { SSH_TABS } from '../src/client/panel/tabs.ts'
import { hasOwnedTunnels } from '../src/client/panel/TunnelsTab.tsx'
import { en, zh } from '../src/client/locales.ts'

/** The tab ids the panel must offer, in display order. */
const EXPECTED_IDS = [
  'hosts',
  'terminal',
  'transfer',
  'tunnels',
  'cluster',
  'deploy',
  'logs',
  'fleet',
]

describe('tab table', () => {
  it('offers every tab in display order', () => {
    expect(SSH_TABS.map(tab => tab.id)).toEqual(EXPECTED_IDS)
  })

  it('uses each id exactly once', () => {
    const ids = SSH_TABS.map(tab => tab.id)
    // A duplicate would make one button select a tab the other also claims.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries a locale key on every tab', () => {
    for (const tab of SSH_TABS) {
      expect(tab.labelKey.length).toBeGreaterThan(0)
    }
  })

  it('labels every tab in both languages', () => {
    for (const tab of SSH_TABS) {
      expect(zh[tab.labelKey], `zh is missing ${tab.labelKey}`).toBeDefined()
      expect(en[tab.labelKey], `en is missing ${tab.labelKey}`).toBeDefined()
    }
  })

  it('does not leave the two languages showing the same raw key', () => {
    // A missing translation falls back to the key itself, which is how a tab
    // ends up labelled "tab.logs" in the UI. Catching it here keeps that out
    // of the panel.
    for (const tab of SSH_TABS) {
      expect(zh[tab.labelKey]).not.toBe(tab.labelKey)
      expect(en[tab.labelKey]).not.toBe(tab.labelKey)
    }
  })

  it('keeps the tab labels short enough to fit a tab bar', () => {
    for (const tab of SSH_TABS) {
      // Long labels push the bar into overflow; these are single words in both
      // languages, and this guards a future edit rather than the current copy.
      expect(zh[tab.labelKey].length, `zh label for ${tab.id}`).toBeLessThanOrEqual(6)
      expect(en[tab.labelKey].length, `en label for ${tab.id}`).toBeLessThanOrEqual(12)
    }
  })
})

/**
 * "Stop all" must not be offered for forwards this plugin cannot stop.
 *
 * Rendering the tunnels tab for the first time showed the button sitting above a
 * list of eight external forwards: it looked enabled, and clicking it could only
 * do nothing. The rule is asserted here so it survives refactoring without a
 * browser.
 */
describe('stop-all availability', () => {
  const base = { id: 't', alias: 'h', localPort: 1, remoteHost: '127.0.0.1', remotePort: 1, state: 'forwarding' as const, startedAt: 0 }

  it('reports no owned tunnels for null or empty', () => {
    expect(hasOwnedTunnels(null)).toBe(false)
    expect(hasOwnedTunnels([])).toBe(false)
  })

  it('hides the action when every forward is external', () => {
    expect(hasOwnedTunnels([{ ...base, source: 'external' }])).toBe(false)
    expect(hasOwnedTunnels([
      { ...base, id: 'a', source: 'external' },
      { ...base, id: 'b', source: 'external' },
    ])).toBe(false)
  })

  it('shows the action for a plugin-owned forward', () => {
    expect(hasOwnedTunnels([{ ...base, source: 'plugin' }])).toBe(true)
  })

  it('shows the action when the source is absent (older rows default to owned)', () => {
    // Rows written before source existed carry no marker; they are ours.
    expect(hasOwnedTunnels([base])).toBe(true)
  })

  it('shows the action when a mix contains at least one owned forward', () => {
    expect(hasOwnedTunnels([
      { ...base, id: 'a', source: 'external' },
      { ...base, id: 'b', source: 'plugin' },
    ])).toBe(true)
  })
})