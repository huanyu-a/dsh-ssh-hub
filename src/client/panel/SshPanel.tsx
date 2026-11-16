/**
 * The SSH operations panel shell: a header with a close control, a five-tab
 * bar, and the active tab's content.
 *
 * The active tab and the terminal tabs live in the controller, not in
 * component state: the layout mounts this page only while the panel is
 * selected, so local state would reset the tab on every panel switch and lose
 * the ids the terminal tab needs to reattach its host-side sessions. Inactive
 * tabs unmount, so each tab fetches its own data on activation.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { SshApi } from '../api.ts'
import type { PanelController, SshTab } from './controller.ts'
import { tt, type TerminalFontSource } from './helpers.ts'
import { SSH_TABS } from './tabs.ts'
import { ClusterTab } from './ClusterTab.tsx'
import { DeployTab } from './DeployTab.tsx'
import { FleetTab } from './FleetTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { LogsTab } from './LogsTab.tsx'
import { TerminalTab } from './TerminalTab.tsx'
import { TransferTab } from './TransferTab.tsx'
import { TunnelsTab } from './TunnelsTab.tsx'
import css from './panel.module.css'

/** Panel shell props. */
export interface SshPanelProps {
  /** The panel state owner (open/close/toggle, active tab, terminal session). */
  controller: PanelController
  /** The SSH API client every tab operates through. */
  api: SshApi
  /** Live terminal-font setting source handed to the terminal tab (issue #577). */
  terminalFont?: TerminalFontSource
}

/** The tab bar definition (labels resolved at render time). */
const TABS = SSH_TABS

/**
 * Render the active tab.
 *
 * A `Record<SshTab, ...>` rather than a chain of `&&` comparisons: the record
 * type requires an entry for every member of the union, so a new tab that is
 * added to `SshTab` and to the tab bar but forgotten here is a compile error.
 * With `&&` comparisons the same omission renders an empty panel — the failure
 * mode where the tab is selectable and shows nothing.
 */
function renderActiveTab(
  activeTab: SshTab,
  { api, controller, terminalFont, panelOpen }: {
    api: SshApi
    controller: PanelController
    terminalFont?: TerminalFontSource
    panelOpen: boolean
  },
): ReactNode {
  const renderers: Record<SshTab, () => ReactNode> = {
    hosts: () => <HostsTab api={api} onConnect={alias => { controller.requestConnect(alias) }} />,
    terminal: () => <TerminalTab api={api} controller={controller} terminalFont={terminalFont} />,
    transfer: () => <TransferTab api={api} />,
    tunnels: () => <TunnelsTab api={api} active={panelOpen} />,
    cluster: () => <ClusterTab api={api} />,
    deploy: () => <DeployTab api={api} active={panelOpen} />,
    logs: () => <LogsTab api={api} active={panelOpen} />,
    fleet: () => <FleetTab api={api} active={panelOpen} />,
  }
  return renderers[activeTab]()
}

/** The tabbed SSH panel. */
export function SshPanel({ controller, api, terminalFont }: SshPanelProps) {
  const { panelOpen, activeTab } = useSyncExternalStore(
    useCallback(listener => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  )

  return (
    <div className={css.panel} data-dsh-plugin="ssh">
      <div className={css.panelHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          aria-label={tt('panel.backToConversation')}
          data-dsh-center-view-back=""
          onClick={() => { controller.close() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{tt('panel.backToConversation')}</span>
        </button>
        <h2 className={css.panelTitle}>{tt('panel.title')}</h2>
      </div>
      <div className={css.tabBar} role="tablist" data-dsh-part="tab-bar">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} data-dsh-part="tab" className={css.tab} onClick={() => { controller.setActiveTab(tab.id) }}>
            {tt(tab.labelKey)}
          </button>
        ))}
      </div>
      <div className={css.panelContent}>
        {renderActiveTab(activeTab, { api, controller, terminalFont, panelOpen })}
      </div>
    </div>
  )
}
