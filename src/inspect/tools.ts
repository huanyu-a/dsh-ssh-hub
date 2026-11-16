/**
 * Agent tools for the inspection layer.
 *
 * Two tools, deliberately split by intent:
 * - `hub_inspect` runs a round of checks and returns the results
 * - `hub_inspect_diff` returns what changed since the previous round
 *
 * The split matters: "check the fleet" and "what changed since I last
 * looked" are different questions, and an agent that has to re-run the
 * whole fleet to answer the second one pays for it in round trips.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from '../engine.ts'
import { BUILTIN_CHECKS, type Check, formatValue, type CheckResult } from './checks.ts'
import type { HostChange, Inspector } from './inspection.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * Resolve the target hosts for an inspection.
 *
 * At least one selector is required, for the same reason `ssh_cluster`
 * requires one: a fleet tool that silently inspects EVERY host when the
 * selector is empty is a foot-gun, and an inspection is cheap but not free
 * on 50 machines.
 *
 * @param engine - the SSH engine (the host list).
 * @param aliases - explicit aliases.
 * @param environment - an environment label (exact match).
 * @param tags - tags that must ALL be present.
 * @returns the selected aliases.
 */
export function resolveTargets(
  engine: SshEngine,
  aliases?: string[],
  environment?: string,
  tags?: string[],
): string[] {
  const hasAlias = aliases !== undefined && aliases.length > 0
  const hasEnvironment = environment !== undefined && environment !== ''
  const hasTags = tags !== undefined && tags.length > 0
  if (!hasAlias && !hasEnvironment && !hasTags) {
    throw new Error('hub_inspect requires aliases, environment, or tags to limit the target set')
  }
  let hosts = engine.store.list()
  if (hasAlias) {
    const wanted = new Set(aliases as string[])
    hosts = hosts.filter(host => wanted.has(host.alias))
  }
  if (hasEnvironment) {
    hosts = hosts.filter(host => host.environment === environment)
  }
  if (hasTags) {
    const wanted = tags as string[]
    // ALL semantics, same as ssh_cluster: every listed tag must be present.
    hosts = hosts.filter(host => wanted.every(tag => host.tags.includes(tag)))
  }
  return hosts.map(host => host.alias)
}

/** The check catalogue as the agent sees it. */
function renderCatalogue(): string {
  const rows = BUILTIN_CHECKS.map(check => {
    const threshold = check.threshold === undefined ? '-' : `${check.direction} ${check.threshold}${check.unit ?? ''}`
    return `${check.id} | ${check.title} | ${threshold}`
  })
  return ['check | title | 触发条件', '--- | --- | ---', ...rows].join('\n')
}

/** One result line. */
function renderResult(check: Check, result: CheckResult): string {
  const state = result.error !== undefined ? `失败（${result.error}）` : result.breached ? '超限' : '正常'
  return `${result.alias} | ${check.title} | ${formatValue(check, result.value)} | ${state}`
}

/** One change line. */
function renderChange(change: HostChange): string {
  const transition = change.stateChange === 'new-breach'
    ? ' → 新增超限'
    : change.stateChange === 'recovered'
      ? ' → 已恢复'
      : ''
  const before = change.before === undefined ? '（新增）' : change.before
  return `${change.alias} | ${change.title} | ${before} → ${change.after}${transition}`
}

/** The inspection tool: run a round of checks. */
export function hubInspectTool(engine: SshEngine, inspector: Inspector) {
  return defineTool({
    name: 'hub_inspect',
    description: 'Run the built-in fleet inspection checks (disk usage, load, memory, inodes, uptime, sshd, failed systemd units, kernel) across selected SSH hosts. Returns each host\'s value and whether it breaches its threshold, and retains the round so the next call can show what changed. Use ssh_exec for a one-off command; use hub_inspect for a repeatable fleet health check.',
    parameters: {
      aliases: { type: 'array', items: { type: 'string' }, description: 'Host aliases to inspect. Optional when environment or tags is given.' },
      environment: { type: 'string', description: 'Inspect only hosts with this environment label (exact match).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Inspect only hosts carrying ALL of these tags.' },
      checks: { type: 'array', items: { type: 'string' }, description: 'Which checks to run (default: all). Call hub_inspect_catalog for the list.' },
      timeoutMs: { type: 'integer', description: 'Per-command timeout in milliseconds (default 30000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          targets: { type: 'array', items: { type: 'string' } },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                checkId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                value: { type: 'string', required: true },
                breached: { type: 'boolean', required: true },
                error: { type: 'string' },
              },
            },
          },
          breaches: { type: 'integer' },
          durationMs: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        targets?: string[]
        results?: Array<{ alias: string; checkId: string; title: string; value: string; breached: boolean; error?: string }>
        breaches?: number
        durationMs?: number
        error?: string
      }) => {
        if (value.error !== undefined) return text(`inspection failed: ${value.error}`)
        if (value.results === undefined) return text('no results')
        const breached = value.results.filter(result => result.breached)
        const lines = [
          `巡检 ${value.targets?.length ?? 0} 台主机，${value.results.length} 项检查，耗时 ${value.durationMs ?? 0}ms`,
          `超限 ${value.breaches ?? breached.length} 项`,
          '',
          ...breached.map(result => `${result.alias} | ${result.title} | ${result.value} | 超限`),
        ]
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const aliases = toStringArray(args.aliases)
      const tags = toStringArray(args.tags)
      const checks = toStringArray(args.checks)
      const targets = resolveTargets(engine, aliases, args.environment, tags)
      if (targets.length === 0) {
        return { ok: true, targets: [], results: [], breaches: 0, durationMs: 0 }
      }
      const round = await inspector.run(engine, targets, checks, args.timeoutMs ?? 30_000)
      const results = round.results.map(result => {
        const check = BUILTIN_CHECKS.find(candidate => candidate.id === result.checkId)
        return {
          alias: result.alias,
          checkId: result.checkId,
          title: check?.title ?? result.checkId,
          value: formatValue(check ?? fallbackCheck(result.checkId), result.value),
          breached: result.breached,
          ...(result.error !== undefined ? { error: result.error } : {}),
        }
      })
      return {
        ok: true,
        targets: round.targets,
        results,
        breaches: results.filter(result => result.breached).length,
        durationMs: round.durationMs,
      }
    },
  })
}

/** The catalogue tool: list the available checks. */
export function hubInspectCatalogTool() {
  return defineTool({
    name: 'hub_inspect_catalog',
    description: 'List the built-in fleet inspection checks with their ids, titles and breach thresholds. Use the ids with hub_inspect to run a subset.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                threshold: { type: 'string', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value: { checks: Array<{ id: string; title: string; threshold: string }> }) => text(renderCatalogue()),
    },
    async execute() {
      return {
        checks: BUILTIN_CHECKS.map(check => ({
          id: check.id,
          title: check.title,
          threshold: check.threshold === undefined
            ? '-'
            : `${check.direction} ${check.threshold}${check.unit ?? ''}`,
        })),
      }
    },
  })
}

/** The diff tool: what changed since the previous round. */
export function hubInspectDiffTool(inspector: Inspector) {
  return defineTool({
    name: 'hub_inspect_diff',
    description: 'Show what changed in the fleet inspection results between the two most recent rounds (values that moved, new breaches, recoveries). Does not run any command on the hosts — it reads the retained history. Use hub_inspect first if no round has been run yet.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                checkId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                before: { type: 'string' },
                after: { type: 'string', required: true },
                stateChange: { type: 'string', enum: ['new-breach', 'recovered'] },
              },
            },
            required: true,
          },
          rounds: { type: 'integer' },
        },
      },
      render: (_args, value: { ok: boolean; changes: HostChange[]; rounds?: number }) => {
        if (value.changes.length === 0) return text('与上一轮相比没有变化')
        const lines = [`与上一轮相比有 ${value.changes.length} 处变化：`, '', ...value.changes.map(renderChange)]
        return text(lines.join('\n'))
      },
    },
    async execute() {
      const rounds = inspector.read(2)
      return { ok: true, changes: inspector.diff(), rounds: rounds.length }
    },
  })
}

/**
 * The monitoring-loop tool: is the fleet being watched, and what did the
 * last round see?
 *
 * This is separate from `hub_inspect` on purpose. `hub_inspect` *runs* a
 * round; this reports on the loop that runs rounds on its own. An agent
 * asked "is the fleet being monitored?" must not have to run a round to
 * answer, because running a round changes the thing being asked about.
 *
 * @param monitor - the loop (absent when the plugin mounted without one).
 * @param store - the host store, for the configured target count.
 * @returns the tool definition.
 */
export function hubMonitorTool(monitor: { status(): Record<string, unknown> } | undefined) {
  return defineTool({
    name: 'hub_monitor',
    description: 'Report whether the fleet monitoring loop is armed: its interval, how many hosts it watches, when the last round ran and when the next one will. An unarmed monitor means an empty alert list means nothing - use this before concluding the fleet is healthy. Pressing Check now in the panel runs the same round this loop runs.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          mounted: { type: 'boolean', required: true },
          running: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value: { mounted: boolean; running: boolean; summary: string }) =>
        text(value.summary),
    },
    async execute() {
      if (monitor === undefined) {
        return {
          mounted: false,
          running: false,
          summary: '监控循环未挂载（插件可能以只读方式运行）。',
        }
      }
      const status = monitor.status()
      const running = status['running'] === true
      const lines: string[] = [running ? '监控已启动' : '监控未启动']
      if (running) {
        const intervalMs = typeof status['intervalMs'] === 'number' ? status['intervalMs'] : 0
        const hosts = typeof status['hosts'] === 'number' ? status['hosts'] : 0
        lines.push(`  间隔 ${Math.round(intervalMs / 1000)}s，覆盖 ${hosts} 台主机`)
        const last = status['lastTick']
        if (typeof last === 'object' && last !== null) {
          const tick = last as Record<string, unknown>
          if (tick['ran'] === true) {
            const at = typeof tick['at'] === 'number' ? new Date(tick['at']).toISOString() : '—'
            lines.push(`  上一轮：${at}，超限 ${String(tick['breaches'] ?? 0)} 项，探针失联 ${String(tick['blind'] ?? 0)} 项`)
          } else {
            lines.push(`  上一轮跳过：${String(tick['skippedBecause'] ?? '原因未知')}`)
          }
        }
        const next = status['nextTickAt']
        if (typeof next === 'number') {
          lines.push(`  下一轮：${new Date(next).toISOString()}`)
        }
      } else {
        // The distinction matters: a stopped loop and a healthy fleet both
        // produce an empty alert list, and only one of them is good news.
        lines.push('  告警列表为空不能说明机群健康——没有任何东西在检查它们。')
        lines.push('  在设置里打开 monitorEnabled，或调用 hub_inspect 手动跑一轮。')
      }
      return { mounted: true, running, summary: lines.join('\n') }
    },
  })
}

/** A stand-in check for a stored result whose check no longer exists. */
function fallbackCheck(checkId: string): Check {
  return {
    id: checkId,
    title: checkId,
    kind: 'text',
    direction: 'above',
    command: '',
    parse: () => null,
  }
}

/**
 * Narrow a tool argument to a string array.
 *
 * The tool parameter schema types arrays as JSON values, so the value
 * arrives as `JsonValue | undefined`. A malformed value is dropped rather
 * than passed on as-is: a selector that is not a list of strings must not
 * silently select the whole fleet.
 *
 * @param value - the raw argument.
 * @returns the strings, or undefined when the value is absent or unusable.
 */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return strings.length === 0 ? undefined : strings
}
