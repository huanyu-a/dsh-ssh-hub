/**
 * Bundle a real component-rendering harness for the preview.
 *
 * Hand-writing markup for the preview was good enough for two tabs, but the
 * panel has eight, plus dialogs and empty states. Recreating them by hand would
 * verify my copy of the markup instead of the components. This bundles the ACTUAL
 * components with react-dom, so what gets rendered and screenshotted is the same
 * code that ships — only the API transport is swapped for one that talks to the
 * running plugin through a local proxy.
 *
 * The bundle is built on demand into the preview scratch directory; nothing is
 * written into src/ or lib/.
 */

import { build } from 'esbuild'
import { CSS_MODULES_PLUGIN } from './css-modules-plugin.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** The harness entry: every tab, mounted one at a time, plus dialogs. */
const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SshApi } from './src/client/api.ts'
import { PanelController } from './src/client/panel/controller.ts'
import { HostsTab } from './src/client/panel/HostsTab.tsx'
import { TerminalTab } from './src/client/panel/TerminalTab.tsx'
import { TransferTab } from './src/client/panel/TransferTab.tsx'
import { TunnelsTab } from './src/client/panel/TunnelsTab.tsx'
import { ClusterTab } from './src/client/panel/ClusterTab.tsx'
import { DeployTab } from './src/client/panel/DeployTab.tsx'
import { LogsTab } from './src/client/panel/LogsTab.tsx'
import { HostFormDialog } from './src/client/panel/HostFormDialog.tsx'
import { TunnelEditDialog } from './src/client/panel/TunnelEditDialog.tsx'
import { SshPanel } from './src/client/panel/SshPanel.tsx'
import css from './src/client/panel/panel.module.css'

const params = new URLSearchParams(location.search)
const which = params.get('tab') ?? 'hosts'

// The panel resolves routes against the same origin in production. The harness
// is served from a local proxy that forwards /api/dsh-ssh to the running plugin,
// so the components exercise their real request paths unchanged.
const api = new SshApi('/')

// The terminal tab genuinely needs the controller that owns its tab records and
// host session ids; omitting it crashed the whole tree and produced a blank
// page. Constructing the real one keeps the rendering honest.
const controller = new PanelController()
controller.open()

const TABS = {
  hosts: [HostsTab, { api, onConnect: () => {} }],
  terminal: [TerminalTab, { api, controller }],
  files: [TransferTab, { api }],
  tunnels: [TunnelsTab, { api, active: true }],
  cluster: [ClusterTab, { api }],
  deploy: [DeployTab, { api, active: true }],
  logs: [LogsTab, { api, active: true }],
  dialog: [HostFormDialog, { api, editing: null, onClose: () => {}, onSaved: () => {} }],
  // Both halves of the tunnel editor: an owned forward (routing fields + the
  // rebuild warning) and an external one (name/remark only), because which
  // fields appear is the whole point of that dialog.
  'tunnel-edit': [TunnelEditDialog, {
    api,
    tunnel: {
      id: 't1', alias: 'tencent', localPort: 7863, remoteHost: '127.0.0.1', remotePort: 7863,
      state: 'forwarding', startedAt: Date.now(), name: 'workbuddy-api', description: 'panel backend',
    },
    onClose: () => {}, onSaved: () => {},
  }],
  'tunnel-remark': [TunnelEditDialog, {
    api,
    tunnel: {
      id: 'ext-38232-0', alias: 'tencent', localPort: 7863, remoteHost: '127.0.0.1', remotePort: 7863,
      state: 'forwarding', startedAt: 0, source: 'external', pid: 38232, kind: 'local', live: true,
      name: 'workbuddy-api', description: 'panel backend', customRemark: true,
    },
    onClose: () => {}, onSaved: () => {},
  }],
}

// The whole panel shell, including its own header and tab strip. The per-tab
// views below render a simplified header, so anything about the header's flex
// behaviour has to be measured on the real component.
if (which === 'shell') {
  const root = createRoot(document.getElementById('root'))
  root.render(React.createElement(SshPanel, { controller, api }))
} else {
  const root = createRoot(document.getElementById('root'))
  root.render(React.createElement(Shell))
}

function Shell() {
  const [Component, props] = TABS[which] ?? TABS.hosts
  const active = which
  const tabNames = ['hosts','terminal','files','tunnels','cluster','deploy','logs']
  // The real scoped class names, imported from the same CSS module the
  // components use. The outer css.panel is not decoration: the --ssh-* tokens
  // are declared on that class, and everything inside inherits them. Without it
  // a button inside a dialog resolved --ssh-fill-primary to the empty string,
  // painted a transparent background, and put near-black text on the page — a
  // contrast failure that existed only in the harness, not in the product.
  return (
    <div className={css.panel}>
      <div className={css.panelHeader}><h2 className={css.panelTitle}>SSH Hub</h2></div>
      <div className={css.tabBar} role="tablist">
        {tabNames.map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            className={css.tab}
            aria-selected={name === active}
            data-active={name === active ? '' : undefined}
          >{name}</button>
        ))}
      </div>
      <div className={css.panelContent}>
        <CrashGuard name={which}>
          <Component {...props} />
        </CrashGuard>
      </div>
    </div>
  )
}

/**
 * Without this, a component that throws unmounts the whole tree and the
 * screenshot is simply blank — which looks like "nothing to see" rather than
 * "this crashed". Reporting the error is the difference between a silent
 * failure and a caught one.
 */
class CrashGuard extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error: error.message ?? String(error) }
  }
  render() {
    if (this.state.error !== null) {
      return (
        <pre
          id="harness-crash"
          style={{ padding: 16, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, color: '#c00' }}
        >{'HARNESS CRASH in "' + this.props.name + '": ' + this.state.error}</pre>
      )
    }
    return this.props.children
  }
}

`

export async function bundleHarness() {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: ROOT,
      loader: 'tsx',
      sourcefile: 'harness-entry.tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    // Reuse the REAL CSS-module handling, imported from the same module the
    // shipping build uses. Stubbing modules to `{}` made every component receive
    // `undefined` as its class name — the harness then rendered unstyled markup,
    // so its screenshots proved nothing about the shipped appearance while
    // looking perfectly plausible.
    plugins: [CSS_MODULES_PLUGIN],
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('harness.mjs')) {
  const out = process.argv[2] ?? join(ROOT, 'artifacts', 'preview', 'harness.js')
  const code = await bundleHarness()
  writeFileSync(out, code)
  console.log(`bundled ${code.length} bytes -> ${out}`)
}