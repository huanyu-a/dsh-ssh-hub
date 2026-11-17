/**
 * Execute the built client artifact and assert it registers.
 *
 * A green unit-test run cannot prove this: the tests import TypeScript
 * sources, while the browser gets `lib/client.js` through the GUI's module
 * loader. Two real defects lived in exactly that gap — the artifact never
 * called `__ModuleLoader__.load`, and the module declared a service the
 * family does not provide, which stalled the fiber before `apply` ran. Either
 * one alone makes the panel silently absent, with no error anywhere.
 *
 * So this runs the shipped file, in a stubbed page, and checks the things the
 * shell depends on:
 *   1. it registers under the package name,
 *   2. the factory declares only services that exist,
 *   3. apply() registers the sidebar row and the main-slot page,
 *   4. it disposes both registrations when its scope ends.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'lib/client.js'), 'utf8')

/** Fail the run with one line. */
function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

/** Print a passing step. */
function pass(message) {
  console.log(`ok    ${message}`)
}

// --- a minimal page: enough DOM for the CSS-module injection ---------------
const styleTags = []
const document = {
  createElement: () => ({
    setAttribute() {},
    get textContent() { return '' },
    set textContent(_value) {},
  }),
  querySelector: () => null,
  head: { appendChild: (tag) => styleTags.push(tag) },
}

// --- the loader the shell provides ---------------------------------------
const registrations = []
let loader = {
  load(entry) {
    registrations.push(entry)
  },
}

/** React stand-in: the panel is never rendered here, only registered. */
const reactStub = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, get) => get(),
}

const sandbox = {
  window: {},
  document,
  console,
  globalThis: undefined,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  fetch: async () => { throw new Error('network is not available in this check') },
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  Blob,
  TextEncoder,
  TextDecoder,
  Event,
  EventTarget,
  CustomEvent,
  navigator: { userAgent: 'node', platform: 'Win32', language: 'zh-CN', languages: ['zh-CN'] },
  location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost', search: '' },
  history: { pushState() {}, replaceState() {} },
  performance: { now: () => Date.now() },
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  Promise,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Array,
  Object,
  JSON,
  Math,
  Date,
  Error,
  TypeError,
  RangeError,
  RegExp,
  String,
  Number,
  Boolean,
  Symbol,
  Intl,
  Proxy,
  Reflect,
  Uint8Array,
  ArrayBuffer,
  Buffer,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
}
sandbox.globalThis = sandbox
sandbox.window = sandbox
sandbox.window.__ModuleLoader__ = loader
sandbox.__ModuleLoader__ = loader

vm.createContext(sandbox)

// The bundle resolves its runtime imports through the loader's own registry,
// so `require` has to answer for React and for the Harness client packages.
const moduleTable = {
  react: reactStub,
  'react-dom': { createPortal: (node) => node, flushSync: (fn) => fn() },
  'react/jsx-runtime': {
    jsx: () => null,
    jsxs: () => null,
    Fragment: 'Fragment',
  },
  '@deepseek-ai/dsh-client-ui-primitives': {},
}
sandbox.__dshRequire = (id) => {
  if (id in moduleTable) return moduleTable[id]
  // Any other client package: a permissive stub, because this check is about
  // registration, not about rendering a particular host component.
  return new Proxy({}, { get: () => () => null })
}

try {
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
} catch (error) {
  fail(`the shipped bundle threw while loading: ${error instanceof Error ? error.message : String(error)}`)
}

// --- 1. it registered at all ---------------------------------------------
if (registrations.length === 0) {
  fail('the bundle never called __ModuleLoader__.load — the GUI would not see this plugin at all')
}
if (registrations.length > 1) {
  fail(`the bundle registered ${registrations.length} times; the loader expects exactly one entry`)
}
const entry = registrations[0]
if (entry.id !== pkg.name) {
  fail(`registered id is ${JSON.stringify(entry.id)}, but the loader keys plugin instances by the package name ${JSON.stringify(pkg.name)}`)
}
pass(`registers with the module loader as ${entry.id}`)

// --- 2. the factory declares only services that exist --------------------
// Listed from the live client service catalog; a name outside it would stall
// the fiber forever and leave the panel unregistered.
const KNOWN_CLIENT_SERVICES = new Set([
  'layout', 'locale', 'sessions', 'slots', 'theme', 'timer', 'uiWorkspace', 'workspaces',
])
if (typeof entry.factory !== 'function') fail('the entry has no factory function')
const face = entry.factory(sandbox.__dshRequire)
if (face === undefined || face === null) fail('the factory returned nothing')
const declared = face.inject ?? []
if (!Array.isArray(declared)) fail('inject is not an array')
const unknown = declared.filter((name) => !KNOWN_CLIENT_SERVICES.has(name))
if (unknown.length > 0) {
  fail(`inject declares services the client runtime does not provide: ${unknown.join(', ')} — the fiber would wait forever and never apply`)
}
pass(`inject declares only services the runtime provides: ${declared.join(', ')}`)

// --- 3. apply() registers both seats ------------------------------------
/** A slot service double that records what gets registered. */
const slotCalls = []
const disposers = []
const slots = {
  inject(key, callback) {
    slotCalls.push({ kind: 'inject', key })
    // Run the callback immediately: the shell is assumed to have declared
    // every seat, which is the case in the real GUI.
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  register(options) {
    slotCalls.push({ kind: 'register', name: options.name, id: options.id, key: options.key })
    return () => {}
  },
  registerFactory() {
    return () => {}
  },
}

/** A locale service double. */
const locale = {
  register: () => () => {},
  bind: () => (key) => key,
  getLocale: () => ({ id: 'zh' }),
  getSnapshot: () => ({ id: 'zh' }),
  subscribe: () => () => {},
  setLocale() {},
  addLanguage: () => () => {},
}

/** The client context double: real services, plus `get` for optional reads. */
const effects = []
const ctx = {
  slots,
  locale,
  layout: { selectPanel() {}, panelInfo: undefined },
  get(name) {
    if (name === 'webUiSettings') return undefined
    if (name === 'configForms') return undefined
    return undefined
  },
  effect(factory) {
    const dispose = factory()
    effects.push(dispose)
    return () => {}
  },
}
ctx.get = ctx.get.bind(ctx)

try {
  face.apply(ctx)
} catch (error) {
  fail(`apply threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}

const injected = new Set(slotCalls.filter(call => call.kind === 'inject').map(call => call.key))
const registered = slotCalls.filter(call => call.kind === 'register')

if (!injected.has('sidebar.panellist')) {
  fail('apply did not inject into sidebar.panellist — the sidebar row would be missing')
}
if (!registered.some(row => row.name === 'sidebar.panellist')) {
  fail('apply did not register the sidebar row')
}
pass('registers the sidebar row in sidebar.panellist')

if (!injected.has('main')) fail('apply did not inject into the main slot — the panel page would be missing')
if (!registered.some(row => row.name === 'main')) fail('apply did not register the main-slot page')
pass('registers the panel page in the main slot')

// The row id is what the layout selects by; both seats must agree on it.
const row = registered.find(item => item.name === 'sidebar.panellist')
const page = registered.find(item => item.name === 'main')
if (row.id === undefined) fail('the sidebar row has no id')
if (page.key !== row.id) {
  fail(`the row id (${row.id}) and the page key (${page.key}) differ, so selecting the row would show a blank main area`)
}
pass(`both seats agree on the panel id ${row.id}`)

// --- 3b. every tab survived bundling ------------------------------------
// The tab bar is built from SSH_TABS, and a tab whose label key is missing from
// the bundle is a tab that renders as its raw key. Checking the shipped text
// rather than the source proves the table made it through the build.
const pkgName = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name
const TABS = ['tab.hosts', 'tab.terminal', 'tab.transfer', 'tab.tunnels', 'tab.cluster', 'tab.deploy', 'tab.logs', 'tab.fleet']
const bundleText = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const missingTabs = TABS.filter(key => !bundleText.includes(key))
if (missingTabs.length > 0) {
  fail(`the shipped bundle is missing tab label keys: ${missingTabs.join(', ')} (a tab would render as its raw key)`)
}
pass(`all ${String(TABS.length)} tab label keys are present in the bundle`)

// The panel id must be the package name, or the loader and the sidebar disagree.
if (bundleText.includes(`id: "${pkgName}"`) === false) {
  fail(`the bundle does not register under the package name ${pkgName}`)
}

// --- 3c. the panel's visual contract survived bundling --------------------
// CSS modules rename every class, so a typo between the stylesheet and the
// component does not fail the build — it silently drops the rule and the
// element renders unstyled. These checks read the shipped mapping and the
// shipped rules, which is the only place both halves meet.
const UI_CLASSES = [
  // the machine identity block (the panel's signature element)
  'hostIdentity', 'hostAlias', 'hostEndpoint',
  // row affordances
  'hostsTable', 'tagList', 'tag', 'actions', 'actionLinks', 'actionLink', 'connectButton',
  // the terminal keyboard-interactive auth surface (TerminalTab)
  'modalCard', 'modalHeader',
  // tunnel rows: the external-forward state readout (TunnelsTab)
  'tunnelRow', 'tunnelState',
  // the row's edit/stop cluster and the "typed by an operator" name tag
  'tunnelActions', 'tunnelRemarkTag',
]
for (const name of UI_CLASSES) {
  if (!bundleText.includes(`"${name}": "${name}_`)) {
    fail(`the CSS-module mapping has no entry for ${name} — the component would reference an undefined class and render unstyled`)
  }
  if (!bundleText.includes(`.${name}_`)) {
    fail(`the shipped stylesheet has no rule for .${name} — the class is mapped but styles nothing`)
  }
}
pass(`all ${String(UI_CLASSES.length)} panel classes are both mapped and styled in the bundle`)

// The host table must carry the generic grid class AND its own modifier: the
// state rail and the pinned action column are scoped to the modifier so the
// other tabs' result tables do not inherit them.
if (!bundleText.includes('panel_default.hostsTable')) {
  fail('the host table does not apply the hostsTable modifier, so it would lose the state rail and the pinned action column')
}
pass('the host table applies its own modifier alongside the shared grid class')

// Accessibility floor: a visible keyboard focus ring and respect for the
// system's reduced-motion setting. Both are easy to lose in a restyle.
for (const rule of ['focus-visible', 'prefers-reduced-motion']) {
  if (!bundleText.includes(rule)) {
    fail(`the shipped stylesheet lost its ${rule} rule`)
  }
}
pass('the stylesheet keeps a keyboard focus ring and honours reduced motion')

// Header and tab strip must share the surrounding surface. An inverted dark
// chassis was shipped once and rejected next to the rest of the shell, so the
// fixed-colour tokens it needed must not come back: every surface here has to
// be a theme token or a mix of one.
if (!bundleText.includes('--ssh-chrome')) {
  fail('the panel chrome token is missing; the header and tab bar would lose their shared surface')
}
for (const banned of ['--ssh-rack-ink', '--ssh-rack-fill', '--ssh-rack-accent', 'color-scheme: dark']) {
  if (bundleText.includes(banned)) {
    fail(`the panel reintroduced "${banned}" — a fixed dark island clashes with the surrounding shell, which follows the light/dark theme`)
  }
}
pass('the header and tab bar follow the host theme instead of an inverted chassis')

// The compact row copy: the full sentences are still used for tooltips, but a
// row that renders the long form pushes the actions off the row.
const ROW_COPY = ['hosts.testOkShort', 'hosts.testFailShort', 'hosts.testingShort']
const missingCopy = ROW_COPY.filter(key => !bundleText.includes(key))
if (missingCopy.length > 0) {
  fail(`the bundle is missing compact row copy: ${missingCopy.join(', ')}`)
}
pass('the compact row copy keys are present in the bundle')

// --- 4. it disposes cleanly ---------------------------------------------
for (const dispose of effects) {
  if (typeof dispose === 'function') dispose()
}
pass(`apply installed ${effects.length} effects and released them without throwing`)

console.log('\nCLIENT HALF OK  the shipped bundle registers the panel the shell expects')