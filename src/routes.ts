/**
 * The /api/dsh-ssh route family: host CRUD, exec, cluster, SFTP transfer
 * (NDJSON progress stream for uploads, binary stream for downloads), remote
 * listing, tunnels, and the WebSocket PTY terminal upgrade. Every route
 * carries a loopback-only trust fence (plus browser same-origin markers) —
 * these endpoints execute commands on remote servers, so LAN-exposed dsh web
 * deployments must not serve them.
 */

import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SshEngine } from './engine.ts'
import { TerminalSessionRegistry } from './engine/terminal-sessions.ts'
import { discoverExternalTunnels } from './engine/tunnel-discovery.ts'
import { readJsonBody, writeJson } from './http.ts'
import { isLoopbackRequest } from './loopback.ts'
import { SSH_API, type HostPayload, type TerminalServerFrame } from './protocol.ts'
import type { DeployRunRow, LogSearchRow, MasterSecretPayload, MasterSecretResult, DeployHostRow, LogHostRow } from './protocol.ts'
import type { ActivityHistory } from './activity/history.ts'
import type { HostStore } from './store.ts'
import type { Monitor } from './monitor/loop.ts'
import { TIERS, type MetricStore } from './monitor/metrics.ts'
import type { Inspector } from './inspect/inspection.ts'
import type { AlertEngine } from './alerting/rules.ts'
import type { AlertEvent } from './alerting/tools.ts'
import { deploy, type DeployPlan, type DeployResult } from './deploy/orchestrator.ts'
import { searchLogs, type LogSearchRequest, type LogSearchResult } from './logs/search.ts'

/**
 * Project a finished deployment into its history record.
 *
 * The panel needs one row per host with the step that failed, not the nested
 * batch structure the orchestrator returns — a batch is an implementation
 * detail of concurrency, while "which host broke and at which step" is the
 * question an operator actually asks.
 *
 * @param result - the orchestrator's outcome.
 * @param hostCount - how many hosts the run intended to reach.
 * @returns the record to persist.
 */
function deployRunFrom(result: DeployResult, hostCount: number): DeployRunRow {
  const hosts: DeployHostRow[] = []
  for (const batch of result.batches) {
    for (const host of batch.results) {
      hosts.push({
        alias: host.alias,
        ok: host.ok,
        // `DeployHostResult` does not report per-step detail — it reports the
        // last exit code and whether the health probe passed. So the record
        // carries the same facts rather than inventing step names.
        steps: [],
        ...(host.healthy === undefined ? {} : { healthy: host.healthy }),
        ...(host.rolledBack === undefined ? {} : { rolledBack: host.rolledBack }),
        ...(host.error === undefined ? {} : { error: host.error }),
        ...(host.exitCode === undefined || host.exitCode === null ? {} : { exitCode: host.exitCode }),
      })
    }
  }
  // Hosts skipped after an earlier failure have no result row; they still
  // belong in the record, marked as not attempted.
  for (const alias of result.skipped) {
    if (hosts.some(row => row.alias === alias)) continue
    hosts.push({ alias, ok: false, steps: [], error: 'skipped: an earlier batch failed' })
  }
  return {
    id: `${result.planId}-${String(Date.now())}`,
    planId: result.planId,
    at: Date.now(),
    batchSize: result.batches[0]?.aliases.length ?? hostCount,
    hostCount,
    ok: result.ok,
    hosts,
  }
}

/**
 * Project a finished log search into its history record.
 * @param result - the search outcome.
 * @param pattern - the pattern that was searched for.
 * @param source - the log source that was read.
 * @param targets - the hosts that were asked.
 * @returns the record to persist.
 */
function logSearchFrom(
  result: LogSearchResult,
  pattern: string,
  source: string,
  targets: string[],
): LogSearchRow {
  return {
    at: Date.now(),
    pattern,
    source,
    targets,
    hosts: result.results.map(host => ({
      alias: host.alias,
      ok: host.ok,
      lines: host.lines,
      // The wire shape names the count `total`; the search layer reports it as
      // `totalMatches`. Translating here keeps one name on the panel side.
      total: host.totalMatches ?? host.lines.length,
      truncated: host.truncated === true,
      ...(host.error === undefined ? {} : { error: host.error }),
      ...(host.durationMs === undefined ? {} : { durationMs: host.durationMs }),
    })),
  }
}

/** Cap on declared upload bodies (staged to disk before SFTP). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/**
 * One noServer WebSocket server for terminal upgrades: the browser half uses
 * a standards-compliant WebSocket, so the host must speak real RFC 6455
 * frames (the webserver hands us the raw upgraded socket).
 */
const terminalWss = new WebSocketServer({ noServer: true })

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/**
 * Parse a `limit` query value into a bounded positive integer.
 *
 * A limit is a display concern, so a malformed or absent value falls back to
 * the default instead of failing the request: a panel asking for history
 * should get history, not a 400 about its own query string.
 *
 * @param raw - the raw query value, if any.
 * @param fallback - the value to use when absent or unparsable.
 * @param max - the hard ceiling.
 * @returns a bounded limit.
 */
function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

/** Route family dependencies. */
export interface SshRoutesDeps {
  /** The host store (CRUD). */
  store: HostStore
  /** The engine (ops). */
  engine: SshEngine
  /** The monitoring loop (status readout). */
  monitor?: Monitor
  /** The metric store (history readout). */
  metrics?: MetricStore
  /** The inspection history (rounds and diff). */
  inspector?: Inspector
  /** The alert engine (rule states). */
  alerts?: AlertEngine
  /** The alert event feed. */
  alertEvents?: AlertEvent[]
  /**
   * Report the live security posture (encryption configured vs active).
   *
   * A callback rather than a value so the route always reads the current
   * config: toggling encryptCredentials in settings must be reflected on the
   * next request, not after a remount.
   */
  security?: () => {
    encryptConfigured: boolean
    secret: { available: boolean; source: 'env' | 'file' | 'none' }
    hostKeyPolicy: string
    auditEnabled: boolean
  }
  /** Temp dir for upload/download staging (tests inject a sandbox). */
  stagingDir?: string
/** Upload byte cap override (tests); defaults to MAX_UPLOAD_BYTES. */
maxUploadBytes?: number
  /** The key file the panel manages (for the status report). */
  keyPath?: string
  /** Aliases whose stored credentials are still plaintext. */
  plaintext?: () => { aliases: string[] }
  /**
   * Store or clear the master secret. Mutating, so the route fences it
   * exactly like any other write; the operation itself decides whether a
   * rotation is required and refuses a change that would strand credentials.
   */
  setSecret?: (payload: MasterSecretPayload) => MasterSecretResult
  /** Deployment history (recorded runs, newest first). */
  deployHistory?: ActivityHistory<DeployRunRow>
  /** Log-search history (recorded searches, newest first). */
  logHistory?: ActivityHistory<LogSearchRow>
}

/**
 * Build every /api/dsh-ssh route (exact paths) plus the terminal upgrade.
 * @param deps - store, engine, staging dir.
 * @returns routes and the upgrade route.
 */
export function makeRoutes(deps: SshRoutesDeps): { routes: WebRoute[]; upgrade: WebUpgradeRoute; terminalSessions: TerminalSessionRegistry } {
  const { store, engine } = deps
  const staging = deps.stagingDir ?? join(tmpdir(), 'dsh-ssh-uploads')
const maxUploadBytes = deps.maxUploadBytes ?? MAX_UPLOAD_BYTES
  // The upload route stages request bodies here; it must exist before the
  // first request (a missing dir would hang the first upload forever).
  // 0700 keeps in-flight transfers unreadable to other local users (the
  // staged files below are 0600; downloads are pre-created 0600 as well).
  mkdirSync(staging, { recursive: true, mode: 0o700 })

  /** Guard helper: fence + method check. */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    // ---------------------------------------------------------- monitor
    {
      // The monitoring loop's own health. The panel's first question about a
      // quiet fleet is "is anything watching it?", and this answers that
      // without inferring it from an empty alert list.
      kind: 'exact',
      path: '/api/dsh-ssh/monitor',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        if (deps.monitor === undefined) {
          writeJson(res, 200, { enabled: false, running: false, reason: 'monitor not mounted' })
          return
        }
        writeJson(res, 200, { enabled: true, ...deps.monitor.status() })
      },
    },
    {
      // Manual round trigger: the same path the timer takes, so the panel's
      // "check now" cannot produce a different result than the loop.
      kind: 'exact',
      path: '/api/dsh-ssh/monitor/tick',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (deps.monitor === undefined) {
          writeJson(res, 200, { ran: false, reason: 'monitor not mounted' })
          return
        }
        // A failure inside the round is reported, not swallowed into a bare
        // 400: the webserver turns a thrown handler into an empty 400, which
        // tells an operator nothing about what broke. A manual trigger is a
        // diagnostic act, so it must say what happened.
        let tick
        try {
          tick = await deps.monitor.tick()
        } catch (error) {
          writeJson(res, 500, { ran: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
        // A missing tick means the round did not run, and the reason matters:
        // "no hosts" and "a round is already in flight" are different
        // problems with different fixes, and reporting both as the latter
        // sends the operator looking for a stuck round that does not exist.
        if (tick === undefined) {
          const last = deps.monitor.ticks.at(-1)
          writeJson(res, 200, {
            ran: false,
            reason: last?.skippedBecause ?? '既没有需要巡检的主机，也没有正在进行的轮次',
          })
          return
        }
        writeJson(res, 200, { ...tick })
      },
    },
    {
      // The recent rounds, newest first, for the inspection history panel.
      kind: 'exact',
      path: '/api/dsh-ssh/inspection',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        if (deps.inspector === undefined) {
          writeJson(res, 200, { rounds: [] })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limit = Number(queryParam(url, 'limit') ?? '10')
        const rounds = deps.inspector.read(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10)
        // Newest first: the panel shows the latest round at the top.
        writeJson(res, 200, { rounds: [...rounds].reverse() })
      },
    },
    {
      // The change set between the two most recent retained rounds.
      kind: 'exact',
      path: '/api/dsh-ssh/inspection/diff',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        if (deps.inspector === undefined) {
          writeJson(res, 200, { changes: [] })
          return
        }
        writeJson(res, 200, { changes: deps.inspector.diff() })
      },
    },
    {
      // The alert states and the recent event feed.
      kind: 'exact',
      path: '/api/dsh-ssh/alerts',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, {
          states: deps.alerts?.list() ?? [],
          events: (deps.alertEvents ?? []).slice(-50).reverse(),
        })
      },
    },
    {
      // The security posture: whether credentials are actually encrypted,
      // and why not when the switch is on but nothing is encrypted. That
      // mismatch is the most confusing state this plugin can present, so it
      // is reported directly rather than left to be inferred.
      kind: 'exact',
      path: '/api/dsh-ssh/security',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const status = deps.security?.()
        writeJson(res, 200, {
          ...(status ?? { encryptConfigured: false, secret: { available: false, source: 'none' } }),
          // The plaintext list belongs with the posture, not in a separate
          // call: "encryption is on" and "which entries are still readable
          // without the key" are one question with one answer.
          ...(deps.plaintext === undefined ? {} : { plaintextAliases: deps.plaintext().aliases }),
          ...(deps.keyPath === undefined ? {} : { keyPath: deps.keyPath }),
        })
      },
    },
    {
      // Store or clear the master secret. This is a WRITE, so it takes the
      // loopback fence and the POST method like every other mutation. The
      // response reports the resulting source and how many entries were
      // re-encrypted, because a secret change that silently skipped rotation
      // would lock the operator out of their own credentials.
      kind: 'exact',
      path: '/api/dsh-ssh/security/secret',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (deps.setSecret === undefined) {
          writeJson(res, 200, { ok: false, source: 'none', rotated: 0, error: 'secret management is not mounted' })
          return
        }
        let payload: MasterSecretPayload
        try {
          payload = (await readJsonBody(req)) as MasterSecretPayload
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' })
          return
        }
        if (payload.action !== 'set' && payload.action !== 'clear') {
          writeJson(res, 400, { error: "action must be 'set' or 'clear'" })
          return
        }
        try {
          writeJson(res, 200, deps.setSecret(payload))
        } catch (error) {
          // A throw here would become an empty 400 from the webserver, which
          // tells the operator nothing about which step failed.
          writeJson(res, 500, { ok: false, source: 'none', rotated: 0, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      // Recorded deployment runs. A rollout's outcome matters after the
      // panel has moved on, so it is retained rather than shown once.
      kind: 'exact',
      path: '/api/dsh-ssh/deploy/history',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limit = clampLimit(queryParam(url, 'limit'), 20, 100)
        writeJson(res, 200, { runs: deps.deployHistory?.read(limit) ?? [] })
      },
    },
    {
      // Recorded log searches, same reasoning as the deployment history.
      kind: 'exact',
      path: '/api/dsh-ssh/logs/history',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limit = clampLimit(queryParam(url, 'limit'), 20, 100)
        writeJson(res, 200, { searches: deps.logHistory?.read(limit) ?? [] })
      },
    },
    {
      // A metric series for one host and tier.
      kind: 'exact',
      path: '/api/dsh-ssh/metrics',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        if (deps.metrics === undefined) {
          writeJson(res, 200, { series: [] })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        const tierParam = queryParam(url, 'tier') ?? '1m'
        const tier = TIERS.find(candidate => candidate.name === tierParam)
        if (tier === undefined) {
          writeJson(res, 400, { error: `unknown tier: ${tierParam} (expected raw|1m|15m|1h)` })
          return
        }
        const metric = queryParam(url, 'metric')
        const limitRaw = Number(queryParam(url, 'limit') ?? '120')
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 120
        writeJson(res, 200, {
          alias,
          tier: tier.name,
          ...(metric !== undefined ? { metric } : {}),
          series: deps.metrics.series(alias, tier.name, metric, limit),
        })
      },
    },
    {
      // Run a deployment plan from the panel. A write with real consequences
      // on remote machines, so: loopback fence, POST only, and the outcome is
      // recorded into the history before it is returned.
      kind: 'exact',
      path: '/api/dsh-ssh/deploy',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        let body: { plan?: DeployPlan; targets?: string[] }
        try {
          body = (await readJsonBody(req)) as { plan?: DeployPlan; targets?: string[] }
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' })
          return
        }
        const plan = body.plan
        if (plan === undefined || typeof plan.id !== 'string' || !Array.isArray(plan.steps) || plan.steps.length === 0) {
          writeJson(res, 400, { error: 'plan.id and a non-empty plan.steps are required' })
          return
        }
        // Every step needs a rollback command, or a failed batch cannot be
        // undone; refuse such a plan here rather than discovering it mid-run.
        const withoutRollback = plan.steps.filter(step => typeof step.rollbackCommand !== 'string' || step.rollbackCommand.trim() === '')
        if (withoutRollback.length > 0) {
          writeJson(res, 400, {
            error: `every step needs a rollbackCommand; missing on: ${withoutRollback.map(step => step.name).join(', ')}`,
          })
          return
        }
        const targets = Array.isArray(body.targets) && body.targets.length > 0
          ? body.targets.filter(alias => typeof alias === 'string' && alias !== '')
          : store.list().map(entry => entry.alias)
        if (targets.length === 0) {
          writeJson(res, 400, { error: 'no hosts to deploy to' })
          return
        }
        let result
        try {
          result = await deploy(engine, plan, targets)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const record = deployRunFrom(result, targets.length)
        deps.deployHistory?.append(record)
        writeJson(res, 200, { run: record, result })
      },
    },
    {
      // Cross-host log search. Read-only on the remote side, but it does run
      // commands (journalctl / grep) on servers, so it stays fenced; and it is
      // POST because the pattern and target set travel in the body.
      kind: 'exact',
      path: '/api/dsh-ssh/logs',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        let body: { request?: LogSearchRequest; targets?: string[] }
        try {
          body = (await readJsonBody(req)) as { request?: LogSearchRequest; targets?: string[] }
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : 'invalid JSON body' })
          return
        }
        const request = body.request
        if (request === undefined || typeof request.pattern !== 'string' || request.pattern === '') {
          writeJson(res, 400, { error: 'request.pattern is required' })
          return
        }
        const targets = Array.isArray(body.targets) && body.targets.length > 0
          ? body.targets.filter(alias => typeof alias === 'string' && alias !== '')
          : store.list().map(entry => entry.alias)
        let result
        try {
          result = await searchLogs(engine, request, targets)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const record = logSearchFrom(result, request.pattern, request.source ?? 'journal', targets)
        deps.logHistory?.append(record)
        writeJson(res, 200, { search: record })
      },
    },
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: SSH_API.hosts,
      handler: async (req, res) => {
        // One handler per path (the webserver keyed route registry rejects
        // duplicate (kind, path)); dispatch by HTTP method here.
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.create(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = store.update(alias, body as unknown as Partial<HostPayload>)
            // Connection-relevant changes invalidate the pooled connection:
            // without this the pool would keep running commands on the old
            // host/credentials until the idle sweep (up to 30 min later).
            // Agent forwarding belongs here too: it is fixed per connection
            // (ssh2 negotiates it when the channel opens), so toggling it must
            // reconnect or the new setting silently never takes effect.
            const patch = body as Record<string, unknown>
            if (['host', 'port', 'user', 'auth', 'proxyJump', 'proxyCommand', 'forwardAgent'].some(key => patch[key] !== undefined)) {
              engine.dropAlias(alias)
            }
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          try {
            engine.dropAlias(alias)
            store.delete(alias)
            // Metric history is keyed by alias alone, so it has to go with the
            // host. Leaving it behind lets the next host to reuse this name
            // inherit another machine's numbers, and those numbers look real.
            deps.metrics?.forget(alias)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: SSH_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          writeJson(res, 200, { result: store.importFromSshConfig() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.localConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { hosts: store.listLocalConfigHosts() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ ops
    {
      kind: 'exact',
      path: SSH_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        if (alias === '') {
          writeJson(res, 400, { error: 'alias is required' })
          return
        }
        try {
          writeJson(res, 200, { result: await engine.test(alias) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const command = typeof body?.command === 'string' ? body.command : ''
        if (alias === '' || command === '') {
          writeJson(res, 400, { error: 'alias and command are required' })
          return
        }
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        try {
          writeJson(res, 200, { result: await engine.exec(alias, command, timeoutMs) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.cluster,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const command = typeof body?.command === 'string' ? body.command : ''
        if (command === '') {
          writeJson(res, 400, { error: 'command is required' })
          return
        }
        const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((x): x is string => typeof x === 'string') : undefined
        const tags = Array.isArray(body?.tags) ? body.tags.filter((x): x is string => typeof x === 'string') : undefined
        const environment = typeof body?.environment === 'string' ? body.environment : undefined
        const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
        const maxWorkers = typeof body?.maxWorkers === 'number' ? body.maxWorkers : undefined
        const hasAliases = aliases?.some(alias => alias.trim() !== '') === true
        const hasEnvironment = typeof environment === 'string' && environment.trim() !== ''
        const hasTags = tags?.some(tag => tag.trim() !== '') === true
        if (!hasAliases && !hasEnvironment && !hasTags) {
          writeJson(res, 400, { error: 'ssh_cluster requires aliases, environment, or tags to limit the target set' })
          return
        }
        try {
          writeJson(res, 200, { results: await engine.cluster({ command, aliases, environment, tags, timeoutMs, maxWorkers }) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------- ls
    {
      kind: 'exact',
      path: SSH_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const path = queryParam(url, 'path') ?? '/'
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        try {
          writeJson(res, 200, { entries: await engine.ls(alias, path) })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // --------------------------------------------------------- tunnel
    {
      kind: 'exact',
      path: SSH_API.tunnel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'list') {
          const managed = engine.listTunnels()
          // Forwards started outside this plugin (`ssh -N -L …`) are real and
          // were invisible: the tab only knew what it had created itself.
          const external = await discoverExternalTunnels(managed)
          writeJson(res, 200, { tunnels: [...managed, ...external] })
          return
        }
        if (action === 'start') {
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          const remotePort = typeof body?.remotePort === 'number' ? body.remotePort : undefined
          if (alias === '' || remotePort === undefined) {
            writeJson(res, 400, { error: 'alias and remotePort are required' })
            return
          }
          try {
            const tunnel = await engine.startTunnel(alias, {
              remotePort,
              remoteHost: typeof body?.remoteHost === 'string' && body.remoteHost !== '' ? body.remoteHost : undefined,
              localPort: typeof body?.localPort === 'number' ? body.localPort : undefined,
            })
            writeJson(res, 200, { tunnel })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (action === 'stop') {
          const id = typeof body?.tunnelId === 'string' ? body.tunnelId : ''
          if (id === '') {
            writeJson(res, 400, { error: 'tunnelId is required' })
            return
          }
          writeJson(res, 200, { ok: engine.stopTunnel(id) })
          return
        }
        if (action === 'stop-all') {
          const alias = typeof body?.alias === 'string' ? body.alias : undefined
          writeJson(res, 200, { stopped: engine.stopAllTunnels(alias === '' ? undefined : alias) })
          return
        }
        writeJson(res, 400, { error: `unknown action '${action}'` })
      },
    },
    // --------------------------------------------------------- upload
    {
      kind: 'exact',
      path: SSH_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
          writeJson(res, 413, { error: 'upload body too large' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
        })
        const emit = (line: unknown): void => {
          try { res.write(JSON.stringify(line) + '\n') } catch { /* client gone */ }
        }
        // Stage the uploaded bytes, then SFTP them out with progress frames.
        const tmp = join(staging, `upload-${randomBytes(6).toString('hex')}`)
        const sink = createWriteStream(tmp, { mode: 0o600 })
        let settled = false
        // End the response only after the tmp file is gone, and unlink only
        // after the sink is fully closed: destroying a WriteStream whose
        // fs.open is still pending lets the open RE-CREATE the file after
        // an early unlink, leaving staging populated (this raced the
        // response end and made the byte-cap test flaky).
        const cleanup = (): void => {
          void unlink(tmp).catch(() => undefined).finally(() => {
            try { res.end() } catch { /* closed */ }
          })
        }
        // Every terminal path (sink error, client abort, response loss) must
        // emit a result frame, end the response, and remove the tmp file.
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          if (sink.destroyed) {
            cleanup()
          } else {
            sink.once('close', cleanup)
            try { sink.destroy() } catch { cleanup() }
          }
        }
        const done = (): void => {
          if (settled) return
          settled = true
          try { res.end() } catch { /* closed */ }
        }
        sink.on('error', (error) => fail(error))
        req.on('error', (error) => fail(error))
        req.on('aborted', () => fail('upload aborted by the client'))
        res.on('error', () => fail('response stream closed'))
        res.on('close', () => { if (!res.writableEnded) fail('connection closed') })
        // The content-length pre-check above can be bypassed by chunked or
        // header-less requests: count the bytes as they actually arrive and
        // abort the moment the cap is exceeded.
        let received = 0
        let capped = false
        req.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > maxUploadBytes && !capped) {
            capped = true
            fail('upload body too large')
            // Keep the socket alive until the response flush finishes:
            // destroying the request here races res.end() and the client
            // sees a hang-up instead of the result frame. Drain the rest of
            // the body so the socket can close cleanly afterwards.
            res.on('finish', () => { try { req.destroy() } catch { /* closed */ } })
            req.resume()
          }
        })
        req.pipe(sink)
        sink.on('finish', async () => {
          if (settled) return
          emit({ type: 'progress', progress: { phase: 'connecting', file: remotePath, transferred: 0, total: 0, percent: 0 } })
          try {
            const outcome = await engine.upload(alias, tmp, remotePath, false, progress => emit({ type: 'progress', progress }))
            emit({ type: 'result', ok: true, transferredBytes: outcome.bytes })
          } catch (error) {
            emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          } finally {
            await unlink(tmp).catch(() => undefined)
            done()
          }
        })
      },
    },
    // ------------------------------------------------------- download
    {
      kind: 'exact',
      path: SSH_API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const tmp = join(staging, `download-${randomBytes(6).toString('hex')}`)
        try {
          // Pre-create with 0600: ssh2's fastGet opens the destination with
          // umask-default permissions and a pre-created file keeps the mode.
          closeSync(openSync(tmp, 'w', 0o600))
          const outcome = await engine.download(alias, remotePath, tmp)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(outcome.bytes),
            'content-disposition': `attachment; filename="${basename(remotePath).replace(/"/g, '')}"`,
            'referrer-policy': 'no-referrer',
          })
          await new Promise<void>((resolve, reject) => {
            const source = createReadStream(tmp)
            source.on('error', reject)
            res.on('error', reject)
            source.pipe(res)
            source.on('end', resolve)
          })
        } catch (error) {
          if (!res.headersSent) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          } else {
            // Mid-stream failure after headers: destroy so the browser does
            // not hang waiting for the promised content-length bytes.
            res.destroy()
          }
        } finally {
          await unlink(tmp).catch(() => undefined)
        }
      },
    },
  ]

  // ---------------------------------------------- terminal (upgrade)
  // The shell outlives the view that opened it: a session is created once and
  // any later socket attaches by id, so a panel switch or a dropped socket
  // does not tear the remote shell down (engine/terminal-sessions.ts).
  const terminalSessions = new TerminalSessionRegistry({
    openShell: (alias, size, onKeyboardInteractive) => engine.openShell(alias, size, onKeyboardInteractive),
  })
  const upgrade: WebUpgradeRoute = {
    path: SSH_API.terminal,
    handler: (req, socket, head) => {
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      const sessionId = queryParam(url, 'session')
      if (alias === undefined && sessionId === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      const size = {
        cols: Number.isFinite(cols) ? cols : 80,
        rows: Number.isFinite(rows) ? rows : 24,
      }
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        if (sessionId !== undefined) {
          if (terminalSessions.attach(ws, sessionId, size)) return
          // The session was reaped or the host restarted: tell the view so it
          // can fall back to a fresh connect instead of sitting blank.
          const expired: TerminalServerFrame = { type: 'exit', code: null, error: 'terminal session expired' }
          try { ws.send(JSON.stringify(expired)) } catch { /* socket raced away */ }
          try { ws.close(1000) } catch { /* already closed */ }
          return
        }
        void terminalSessions.open(ws, alias as string, size)
      })
    },
  }

  return { routes, upgrade, terminalSessions }
}
