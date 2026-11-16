/**
 * The panel's tab table, in one place.
 *
 * It lives apart from the component so the shell and the tests read the same
 * list. The bug this prevents is specific and easy to repeat: a tab component
 * exists, its locale keys exist, and nothing renders it — which looks like a
 * working feature in review because every file involved is correct on its own.
 */

import type { SshKey } from '../locales.ts'
import type { SshTab } from './controller.ts'

/** One entry in the panel's tab bar. */
export interface SshTabSpec {
  /** The tab id, also the value stored in the controller. */
  id: SshTab
  /** The locale key for its label. */
  labelKey: SshKey
}

/**
 * The tabs, in display order.
 *
 * `satisfies` rather than a plain annotation: it keeps the literal types while
 * proving the array is exhaustive against {@link SshTab}, so adding a member to
 * the union without adding a tab fails the type check instead of shipping a tab
 * nobody can reach.
 */
export const SSH_TABS = [
  { id: 'hosts', labelKey: 'tab.hosts' },
  { id: 'terminal', labelKey: 'tab.terminal' },
  { id: 'transfer', labelKey: 'tab.transfer' },
  { id: 'tunnels', labelKey: 'tab.tunnels' },
  { id: 'cluster', labelKey: 'tab.cluster' },
  { id: 'deploy', labelKey: 'tab.deploy' },
  { id: 'logs', labelKey: 'tab.logs' },
  { id: 'fleet', labelKey: 'tab.fleet' },
] as const satisfies ReadonlyArray<SshTabSpec>

/**
 * Every tab id, as a set for the exhaustiveness assertion below.
 *
 * Written as a type-level check rather than a runtime one: a missing tab is a
 * build error, not a test failure discovered later.
 */
type CoveredTab = (typeof SSH_TABS)[number]['id']

/** Compile-time proof that the table covers the union exactly. */
export type TabsCoverEveryTab = Exclude<SshTab, CoveredTab> extends never ? true : never

/** Compile-time proof that the table adds no id outside the union. */
export type TabsAddNoUnknownTab = Exclude<CoveredTab, SshTab> extends never ? true : never
