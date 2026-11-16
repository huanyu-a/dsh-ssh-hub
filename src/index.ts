/**
 * dsh-ssh — host half. Mounts the SSH engine (persistent ssh2 connection
 * pool, exec / PTY shell / SFTP / tunnels / cluster), the /api/dsh-ssh route
 * family plus the terminal WebSocket upgrade, the agent tools (ssh_list,
 * ssh_exec, ssh_upload, ssh_download, ssh_tunnel, ssh_cluster), and a
 * system-prompt announcement. The browser half (./client) renders the host
 * manager and web terminal. Everything rides official NPM SDK packages —
 * no dsh source changes.
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { SshEngine } from './engine.ts'
import { DEFAULT_CONNECT_TIMEOUT_MS } from './engine/connection-pool.ts'
import { makeRoutes } from './routes.ts'
import { HostStore, type SecretProtector } from './store.ts'
import { sshClusterTool, sshDownloadTool, sshExecTool, sshListTool, sshTunnelTool, sshUploadTool } from './tools.ts'
import { Inspector } from './inspect/inspection.ts'
import { findCheck } from './inspect/checks.ts'
import { hubInspectCatalogTool, hubInspectDiffTool, hubInspectTool, hubMonitorTool } from './inspect/tools.ts'
import { AlertEngine } from './alerting/rules.ts'
import { hubAlertRulesTool, hubAlertsTool, hubAlertTestTool, defaultRules, type AlertEvent } from './alerting/tools.ts'
import { notifyAll, type NotifyChannel } from './alerting/notify.ts'
import { hubDeployTool } from './deploy/tools.ts'
import { hubLogSearchTool } from './logs/tools.ts'
import { Monitor } from './monitor/loop.ts'
import { MetricStore, samplesFromRound } from './monitor/metrics.ts'
import { mountOnce } from './mount-once.ts'
import { PLUGIN_TOOL_SECTION_ORDERS, visibleToolText } from './tool-surface.ts'
import { defaultKnownHostsPath } from './security/known-hosts.ts'
import { isSealed, open, seal } from './security/secrets.ts'
import { AuditLog } from './audit/audit-log.ts'
import { AuditRecorder } from './audit/recorder.ts'

/** Stable cordis plugin name. */
export const name = 'ssh'

/**
 * Services required before the SSH surfaces can mount.
 *
 * `timer` is required rather than optional: the monitoring loop is armed
 * through it, and a plugin that silently fell back to a bare setInterval
 * would leave a probe timer running after the plugin unloaded. Requiring it
 * makes a profile without the timer service fail to activate this row
 * instead of leaking timers.
 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'timer']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running instance without a
     * remount (cordis-plugin-loader); dispatched to the owning fiber only.
     * @param paths - the changed config paths, as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** Plugin config as a profile patch declares it, before schema resolution. */
export interface Config {
  /**
   * When true, a system-prompt section announces the SSH plugin to every agent
   * (tools + host store). Off by default to keep prompts clean.
   */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /**
   * xterm `fontFamily` for the web terminal (issue #577). Empty (default)
   * defers to the CSS chain: `--dsh-ssh-terminal-font`, then the official
   * `--ds-font-family-code` token, then the built-in monospace stack. Set a
   * Nerd Font stack here to render powerline/Nerd glyphs.
   */
  terminalFontFamily?: string
  /**
   * Ceiling for the whole pre-ready SSH sequence in milliseconds: TCP
   * connect, key exchange and user authentication (default 30000). Raise it
   * for hosts whose password authentication is slow (for example PAM / LDAP
   * behind a distant directory service).
   */
  connectTimeoutMs?: number
}

/** The stable reference a `volatile()` config field resolves to; its owner updates it in place. */
interface ConfigRef<T> {
  /** @returns the field's current value. */
  get(): T
}

/** One resolved config field: a live reference, or a plain value from a hand-built context. */
type ConfigField<T> = ConfigRef<T> | T

/** The config the Host hands to {@link apply} — the runtime face of {@link Config}. */
export interface ResolvedConfig {
  announceToAgent?: ConfigField<boolean>
  enabled?: ConfigField<boolean>
  terminalFontFamily?: ConfigField<string>
  connectTimeoutMs?: ConfigField<number>
  hostKeyPolicy?: ConfigField<'off' | 'tofu' | 'strict'>
  knownHostsPath?: ConfigField<string>
  encryptCredentials?: ConfigField<boolean>
  auditEnabled?: ConfigField<boolean>
  monitorEnabled?: ConfigField<boolean>
  monitorIntervalMs?: ConfigField<number>
  monitorChecks?: ConfigField<string>
}

/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page: the Host derives one form per profile entry from it
 * and serves it through the shared configuration forms. Every field is
 * `volatile()`, which is what puts it on that page and what lets an edit reach
 * a running instance without a remount: the loader commits the new value into
 * the field's reference and announces `loader/volatile-update` on this fiber.
 */
export const Config = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  terminalFontFamily: z.string().default('').volatile(),
  connectTimeoutMs: z.number().step(1).min(1_000).max(600_000).default(DEFAULT_CONNECT_TIMEOUT_MS).volatile()
    .description('TCP connect, SSH key exchange and user authentication timeout in milliseconds; raise it for hosts whose authentication is slow.'),
  hostKeyPolicy: z.union(['off', 'tofu', 'strict'] as const).default('off').volatile()
    .description('Host-key verification against ~/.ssh/known_hosts. "off" accepts any key (the legacy behaviour); "tofu" records an unknown host and refuses a changed key; "strict" refuses anything not already trusted. A changed or revoked key is refused under every policy.'),
  knownHostsPath: z.string().default('').volatile()
    .description('Path to the known_hosts file used for host-key verification. Empty uses ~/.ssh/known_hosts.'),
  encryptCredentials: z.boolean().default(false).volatile()
    .description('Encrypt stored passwords and key passphrases. Needs DSH_SSH_HUB_SECRET in the environment as the master secret; there is deliberately no default, because a default master secret is a backdoor. With no master secret the secrets stay in plaintext, exactly as before.'),
  auditEnabled: z.boolean().default(true).volatile()
    .description('Record every operation (exec, cluster, transfer, deploy, credential change) in an append-only audit log under $DSH_HOME/dsh-ssh-hub/audit.log. Secrets are redacted before a record is written.'),
  monitorEnabled: z.boolean().default(false).volatile()
    .description('Run fleet inspection on a timer and feed the alert rules. Off by default: a monitoring loop that starts probing servers the moment the plugin is enabled is a surprise, and the operator should choose when the fleet starts being watched. Requires at least one configured host.'),
  monitorIntervalMs: z.number().step(1000).min(10_000).max(3_600_000).default(60_000).volatile()
    .description('How often the monitor runs an inspection round, in milliseconds. Default 60s. A round that outlasts the interval skips the next tick rather than running two rounds at once.'),
  monitorChecks: z.string().default('').volatile()
    .description('Comma-separated check ids the monitor runs (default: all built-in checks). Empty means every check; call hub_inspect_catalog for the ids.'),
})

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false
const DEFAULT_ENABLED = true

/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    const value = (field as ConfigRef<T>).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * Parse the comma-separated check list config.
 *
 * An empty string means "all checks", not "no checks": an operator who
 * cleared the field wants the default set, and running zero checks on a
 * timer would be a monitor that watches nothing.
 *
 * @param raw - the config string.
 * @returns the check ids, or undefined for "all".
 */
function parseCheckList(raw: string): string[] | undefined {
  const ids = raw.split(',').map(id => id.trim()).filter(id => id !== '')
  return ids.length === 0 ? undefined : ids
}

/**
 * The master secret used to encrypt stored credentials.
 *
 * Two sources, in priority order:
 *
 * 1. `DSH_SSH_HUB_SECRET` — the secret itself in the environment.
 * 2. `DSH_SSH_HUB_SECRET_FILE` — a path to a file containing the secret.
 *
 * The second exists because the first is a poor fit for a long-running
 * desktop profile: an environment variable has to be set in whatever
 * launches DSH, which means it lands in shell profiles and shortcut
 * properties, where it is readable by anything running as the same user and
 * gets copied into screenshots of the launcher. A 0600 file is easier to
 * protect and easier to back up.
 *
 * Neither is a default. With no secret configured the store keeps
 * plaintext, which is exactly what the operator chose by not configuring
 * one; a built-in default key would be a backdoor, not a convenience.
 *
 * The DSH credentials service was the intended third source, but it is an
 * async service and this plugin's apply is synchronous, and reading an
 * undeclared service off the context throws at mount time. A secret that
 * cannot be read at mount time cannot protect a store that is opened at
 * mount time.
 *
 * @returns the master secret, or undefined when none is configured.
 */
function readMasterSecret(): string | undefined {
  const fromEnv = process.env.DSH_SSH_HUB_SECRET
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv

  const filePath = process.env.DSH_SSH_HUB_SECRET_FILE
  if (filePath === undefined || filePath.trim() === '') return undefined
  try {
    const fromFile = readFileSync(filePath.trim(), 'utf8')
    // A trailing newline is normal in a secret file written by an editor or
    // by `echo`; keeping it would derive a different key from the same text.
    const trimmed = fromFile.replace(/\r?\n$/, '')
    return trimmed !== '' ? trimmed : undefined
  } catch {
    // A configured-but-unreadable file is not worth guessing about: fall
    // through to plaintext (the operator's store was already plaintext or
    // unopenable) rather than throwing and taking the whole plugin down.
    return undefined
  }
}

/**
 * Describe where the master secret came from, for the settings panel.
 *
 * The panel must be able to tell an operator *whether* encryption is active
 * and *why not* — "encryptCredentials is on but nothing is encrypted" is
 * the single most confusing state this plugin can present.
 *
 * @returns the source label and whether a secret is available.
 */
function masterSecretStatus(): { available: boolean; source: 'env' | 'file' | 'none' } {
  const fromEnv = process.env.DSH_SSH_HUB_SECRET
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { available: true, source: 'env' }
  const filePath = process.env.DSH_SSH_HUB_SECRET_FILE
  if (filePath !== undefined && filePath.trim() !== '' && readMasterSecret() !== undefined) {
    return { available: true, source: 'file' }
  }
  return { available: false, source: 'none' }
}

/**
 * The known_hosts file to consult.
 *
 * @param configured - the configured path (empty means the default).
 * @returns the resolved path.
 */
function resolveKnownHostsPath(configured: string): string {
  return configured.trim() === '' ? defaultKnownHostsPath() : configured.trim()
}

/**
 * The loader's own record of the profile entry this instance was activated
 * from, which carries the row's raw config — the user's own declaration, as
 * opposed to the schema defaults and the inherited bundle layers. Absent on a
 * host without the loader, which reads as "the profile declares nothing".
 */
interface LoaderEntry {
  options?: { config?: unknown }
}

/** Raw config the profile declares for this entry, when the loader exposes it. */
function profileConfig(ctx: Context): Record<string, unknown> | undefined {
  const entry = (ctx.fiber as Fiber & { entry?: LoaderEntry }).entry
  const config = entry?.options?.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  return config as Record<string, unknown>
}

/** Order of the announcement section within the shared tool-guidance band. */
const SECTION_ORDER = PLUGIN_TOOL_SECTION_ORDERS.ssh

/**
 * The twelve agent-tool names this plugin's announcement describes.
 *
 * The first six are the base plugin's; the rest are the fleet-operations
 * layer added here.
 */
const SSH_TOOL_NAMES = [
  'ssh_list', 'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel', 'ssh_cluster',
  'hub_inspect', 'hub_inspect_catalog', 'hub_inspect_diff', 'hub_monitor',
  'hub_alerts', 'hub_alert_rules', 'hub_alert_test',
  'hub_deploy', 'hub_log_search',
] as const

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SSH_GUIDANCE = [
  '本机已安装 dsh-ssh-hub 插件（DSH 远程 SSH 车队运维）：侧边栏「SSH」入口。',
  '能力：主机配置存 $DSH_HOME/dsh-ssh.json（默认 ~/.dsh），可从 ~/.ssh/config 导入；',
  '持久连接池复用长连接（空闲 30 分钟自动断开）；',
  'ssh_list 列出主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、',
  'ssh_tunnel 本地端口转发、ssh_cluster 按 aliases/environment/tags 至少一种非空 selector 集群并发执行；',
  'hub_inspect 运行内置巡检项（磁盘/负载/内存/inode/运行时长/sshd/失败单元/内核）并留存本轮结果，',
  'hub_inspect_diff 对比上一轮找出变化（值漂移、新增超限、已恢复），hub_inspect_catalog 列出巡检项，',
  'hub_monitor 报告定时监控是否在跑（监控未启动时告警列表为空并不代表机群健康）；',
  'hub_alerts 查看告警状态与事件、hub_alert_rules 调整规则、hub_alert_test 测试通知渠道；',
  'hub_deploy 分批部署并做健康检查、失败自动回滚、跳过未部署主机；',
  'hub_log_search 跨机检索 journald 或日志目录，结果按主机限量并提示截断。',
  '内置巡检项均为只读 POSIX 命令，不在远程安装任何东西。',
  '限制：主机操作由用户在 GUI 中配置后 agent 方可使用；',
  '凭据在配置了 DSH_SSH_HUB_SECRET 时以 AES-256-GCM 加密落盘，未配置时保持明文（插件会提示不要在无密钥时保存密码）；',
  '主机指纹可按 hostKeyPolicy=tofu/strict 对照 known_hosts 校验；',
  '命令输出在返回前经脱敏（密码/token/私钥/连接串/云密钥），但脱敏是安全网不是保证；',
  '断线重连可能重放非幂等命令；传输/执行消耗真实远程资源，先确认再操作。',
  '路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / bash），ssh_* 工具只针对远程主机上的路径。',
  '用户提到「SSH / 远程服务器 / 服务器操作 / 跳板机 / 隧道 / 部署 / 巡检 / 告警 / 日志检索 / 上传下载」时即指本插件，请据此协作。',
].join('')

/**
 * Mount the SSH engine, routes, tools, and announcement.
 *
 * The mount guard keys on THIS package's identity, not the upstream one:
 * both plugins register the same HTTP route prefix and the same sidebar
 * row, so they must never share a mount slot — and if an operator has both
 * installed, only one of them may own the routes.
 *
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('dsh-ssh-hub', applyImpl)

function applyImpl(ctx: Context, config?: ResolvedConfig): void {
  // The master secret for credential encryption. There is deliberately no
  // default: a default master secret would be a backdoor, and falling back
  // to plaintext would defeat the point of encrypting at all. With no
  // secret configured the store keeps the base plugin's plaintext
  // behaviour, so enabling encryption is a deliberate act.
  const masterSecret = readMasterSecret()
  const encryptCredentials = readConfigField(config?.encryptCredentials, false)
  // Encryption needs BOTH the operator's consent and a key. Consent without a
  // key cannot encrypt; a key without consent must not encrypt, or an operator
  // who never opted in would find their store rewritten in a format they did
  // not choose.
  const protector: SecretProtector | undefined = (encryptCredentials && masterSecret !== undefined)
    ? {
        seal: plaintext => seal(plaintext, masterSecret),
        open: stored => (isSealed(stored) ? open(stored, masterSecret) : undefined),
      }
    : undefined

  const store = new HostStore(undefined, undefined, protector)
  const engine = new SshEngine(store, {
    connectTimeoutMs: readConfigField(config?.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    hostKeyPolicy: readConfigField(config?.hostKeyPolicy, 'off'),
    knownHostsPath: resolveKnownHostsPath(readConfigField(config?.knownHostsPath, '')),
  })
  ctx.effect(() => () => { engine.dispose() }, 'dsh-ssh: engine')

  // The audit trail: every mutation of the fleet and every command that
  // changes a remote host is recorded. It is on by default, because an
  // operator cannot retroactively decide to have had an audit log.
  const audit = readConfigField(config?.auditEnabled, true) ? new AuditLog() : undefined

  // The inspection layer: retained rounds of the built-in fleet checks.
  const inspector = new Inspector()

  // The alerting layer: rule state plus the recent event feed.
  const alertEngine = new AlertEngine()
  const alertRules = defaultRules()
  const alertEvents: AlertEvent[] = []
  const notifyChannels: NotifyChannel[] = []

  // The metric store: tiered history behind the inspection rounds.
  const metricStore = new MetricStore()

  // The monitoring loop: inspection on a timer, feeding the alert rules.
  // It is created unconditionally but only armed when the config asks for
  // it, so the status route can report "configured but off" rather than
  // making the panel guess why nothing is happening.
  const monitor = new Monitor(
    engine,
    inspector,
    alertEngine,
    alertEvents,
    {
      intervalMs: readConfigField(config?.monitorIntervalMs, 60_000),
      checks: parseCheckList(readConfigField(config?.monitorChecks, '')),
      rules: alertRules,
      targets: () => store.list().map(host => host.alias),
    },
    async (notification) => {
      await notifyAll(notifyChannels, notification, {
        '#RULE.NAME#': notification.title,
        '#STATE#': notification.kind === 'trigger' ? '告警' : '已恢复',
        '#MESSAGE#': `${notification.alias} ${notification.title}: ${notification.kind === 'trigger' ? '告警' : '已恢复'} (${notification.value})`,
      })
    },
  )

  // Every completed round feeds the metric store, so the history tiers stay
  // current whether the round came from the timer or from a hub_inspect call.
  inspector.onRound = (round) => {
    for (const alias of round.targets) {
      const results = round.results.filter(result => result.alias === alias)
      if (results.length === 0) continue
      metricStore.record(alias, samplesFromRound(round.startedAt, results, checkId => findCheck(checkId)?.kind))
    }
  }

  const resolve = (): { announceToAgent: boolean; enabled: boolean } => {
    let enabled = readConfigField(config?.enabled, DEFAULT_ENABLED)
    // When dsh-ssh was seeded with enabled: false (e.g. from an aggregate profile
    // line), but the profile's own entry config never set the switch AND the user
    // already has active host records in dsh-ssh.json, keep the plugin enabled so
    // existing users are not broken upon upgrade (#1250).
    if (enabled === false && profileConfig(ctx)?.enabled === undefined && store.list().length > 0) {
      enabled = true
    }
    return {
      announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE),
      enabled,
    }
  }

  // The /api/dsh-ssh route family + terminal upgrade.
  const { routes, upgrade, terminalSessions } = makeRoutes({
    store,
    engine,
    monitor,
    metrics: metricStore,
    inspector,
    alerts: alertEngine,
    alertEvents,
    security: () => ({
      // The two conditions that must both hold for credentials to be
      // encrypted. Reporting them separately is the point: "switch on, no
      // secret" and "secret present, switch off" need different fixes.
      encryptConfigured: readConfigField(config?.encryptCredentials, false),
      secret: masterSecretStatus(),
      hostKeyPolicy: readConfigField(config?.hostKeyPolicy, 'off'),
      auditEnabled: readConfigField(config?.auditEnabled, true),
    }),
  })
  let disposeRoutes: (() => void) | undefined
  let disposeMonitor: (() => void) | undefined

  // Agent tools + their prompt sections.
  const recorder = new AuditRecorder(audit)
  const tools = [
    sshListTool(engine),
    sshExecTool(engine, recorder),
    sshUploadTool(engine, recorder),
    sshDownloadTool(engine, recorder),
    sshTunnelTool(engine, recorder),
    sshClusterTool(engine, recorder),
    hubInspectTool(engine, inspector),
    hubInspectCatalogTool(),
    hubMonitorTool(monitor),
    hubInspectDiffTool(inspector),
    hubAlertsTool(alertEngine, alertEvents),
    hubAlertRulesTool(alertRules),
    hubAlertTestTool(notifyChannels),
    hubDeployTool(engine, recorder),
    hubLogSearchTool(engine),
  ]
  let disposeTools: (() => void) | undefined

  // System-prompt announcement.
  let disposeSection: (() => void) | undefined

  // Register (or drop) every surface to match the resolved config. Each group
  // is kept under one disposer: re-registering first tears the old one down
  // so duplicate-name registrations never throw.
  const sync = (): void => {
    // A settings edit reaches this instance without a remount; apply the
    // connection ceiling before re-deriving the surfaces so connections opened
    // by the request that follows use the new value.
    engine.setConnectTimeout(readConfigField(config?.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS))
    const value = resolve()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    // The loop is stopped before the surfaces are re-derived, so a settings
    // edit cannot leave the old interval running alongside a new one (two
    // timers would double every probe against the fleet).
    if (disposeMonitor !== undefined) {
      disposeMonitor()
      disposeMonitor = undefined
    }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-ssh',
        order: SECTION_ORDER,
        // The announcement names the ssh_* tools, so it renders only while at
        // least one of them is reachable: a restriction that removes the tool
        // surface must take the guidance with it, instead of telling the model
        // to call tools this session cannot see.
        text: visibleToolText(ctx.tools, SSH_TOOL_NAMES, SSH_GUIDANCE),
      })
    }
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
          // Dropping the routes also ends the terminal sessions they served:
          // a live shell must not outlive the surface that can reach it.
          terminalSessions.dispose()
        }
      },
      'dsh-ssh: routes',
    )
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ssh: tools',
    )
    // Arm the monitoring loop last, so its first round runs against a fully
    // registered surface. A loop that starts before the tools exist would
    // record rounds no tool can read.
    if (readConfigField(config?.monitorEnabled, false)) {
      monitor.start(ctx.timer)
      // The loop owns no effect of its own; this one carries the interval
      // disposer onto the plugin fiber, so disabling the plugin stops the
      // probing instead of leaving an orphan timer watching the fleet.
      disposeMonitor = ctx.effect(() => () => { monitor.stop() }, 'dsh-ssh: monitor')
    }
  }

  // A settings edit is committed into this instance's config references and
  // announced on the owning fiber (the entry is not remounted), so the
  // surfaces are re-derived from the new values here.
  ctx.on('loader/volatile-update', () => { sync() })

  // Initial registration from the config the Host activated this row with.
  sync()
}
