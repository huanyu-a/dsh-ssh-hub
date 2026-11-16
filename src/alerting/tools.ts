/**
 * Agent tools for the alerting layer.
 *
 * Three tools:
 * - `hub_alerts` — the current alert states and the recent events
 * - `hub_alert_rules` — list and update the rules
 * - `hub_alert_test` — send a test notification to the configured channels
 *
 * The test tool matters more than it looks: an operator who configured a
 * webhook and never received a message does not know whether the rule
 * never fired or the channel is broken. One call tells them.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AlertEngine, type AlertRule } from './rules.ts'
import { NOTIFY_PRESETS, notifyAll, type NotifyChannel } from './notify.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** The default rule set: the checks whose thresholds matter most. */
export function defaultRules(): AlertRule[] {
  return [
    { id: 'disk-full', checkId: 'disk-usage', forSeconds: 120, cooldownSeconds: 1800, enabled: true },
    { id: 'memory-pressure', checkId: 'memory-used', forSeconds: 180, cooldownSeconds: 1800, enabled: true },
    { id: 'load-high', checkId: 'load-average', forSeconds: 300, cooldownSeconds: 1800, enabled: true },
    { id: 'inodes-full', checkId: 'disk-inodes', forSeconds: 120, cooldownSeconds: 1800, enabled: true },
    { id: 'sshd-down', checkId: 'sshd-running', forSeconds: 60, cooldownSeconds: 900, enabled: true },
  ]
}

/** The alerts tool: the current state and the recent events. */
export function hubAlertsTool(engine: AlertEngine, events: AlertEvent[]) {
  return defineTool({
    name: 'hub_alerts',
    description: 'Show the current fleet alert states (which rules are firing, pending, or frozen) and the most recent alert events. A frozen state means the probe could not read the value - the machine may be unreachable, which is different from healthy. Use hub_inspect to refresh the values first.',
    parameters: {
      limit: { type: 'integer', description: 'How many recent events to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          states: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                state: { type: 'string', enum: ['ok', 'pending', 'firing', 'frozen'], required: true },
                consecutiveBreaches: { type: 'integer', required: true },
                lastValue: { type: 'string' },
              },
            },
            required: true,
          },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                kind: { type: 'string', enum: ['trigger', 'recover'], required: true },
                value: { type: 'string', required: true },
                at: { type: 'integer', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value: { ok: boolean; states: Array<{ ruleId: string; alias: string; state: string; consecutiveBreaches: number }>; events: Array<{ ruleId: string; alias: string; kind: string; value: string }> }) => {
        const firing = value.states.filter(state => state.state === 'firing')
        const frozen = value.states.filter(state => state.state === 'frozen')
        const lines = [
          `告警状态：触发 ${firing.length}，冻结（探针失联）${frozen.length}，共 ${value.states.length} 条`,
          '',
          ...firing.map(state => `${state.alias} | ${state.ruleId} | 触发中（连续 ${state.consecutiveBreaches} 轮）`),
          ...frozen.map(state => `${state.alias} | ${state.ruleId} | 探针失联，状态已冻结`),
        ]
        if (value.events.length > 0) {
          lines.push('', '最近事件：', ...value.events.map(event => `${event.alias} | ${event.ruleId} | ${event.kind === 'trigger' ? '触发' : '恢复'} | ${event.value}`))
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const limit = args.limit ?? 20
      return {
        ok: true,
        states: engine.list().map(state => ({
          ruleId: state.ruleId,
          alias: state.alias,
          state: state.state,
          consecutiveBreaches: state.consecutiveBreaches,
          ...(state.lastValue !== undefined ? { lastValue: String(state.lastValue) } : {}),
        })),
        events: events.slice(-limit).map(event => ({
          ruleId: event.ruleId,
          alias: event.alias,
          kind: event.kind,
          value: event.value,
          at: event.at,
        })),
      }
    },
  })
}

/** The rules tool: list and update the rules. */
export function hubAlertRulesTool(rules: AlertRule[]) {
  return defineTool({
    name: 'hub_alert_rules',
    description: 'List the fleet alert rules, or enable/disable one, or change how long a breach must persist before it fires. A rule needs the breach to hold for the "for" seconds across consecutive rounds before it fires, so a one-off spike does not page the operator.',
    parameters: {
      action: { type: 'string', enum: ['list', 'set'], required: true },
      id: { type: 'string', description: 'The rule id (required for set).' },
      enabled: { type: 'boolean', description: 'Enable or disable the rule.' },
      forSeconds: { type: 'integer', description: 'How many seconds the breach must persist before the alert fires.' },
      cooldownSeconds: { type: 'integer', description: 'How long to wait before re-notifying a continued breach.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                checkId: { type: 'string', required: true },
                forSeconds: { type: 'integer', required: true },
                cooldownSeconds: { type: 'integer', required: true },
                enabled: { type: 'boolean', required: true },
              },
            },
            required: true,
          },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; rules: Array<{ id: string; checkId: string; forSeconds: number; cooldownSeconds: number; enabled: boolean }>; error?: string }) => {
        if (value.error !== undefined) return text(`rule error: ${value.error}`)
        const lines = ['规则 | 检查项 | 持续 | 冷却 | 状态', '--- | --- | --- | --- | ---']
        for (const rule of value.rules) {
          lines.push(`${rule.id} | ${rule.checkId} | ${rule.forSeconds}s | ${rule.cooldownSeconds}s | ${rule.enabled ? '启用' : '停用'}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      if (args.action === 'list') {
        return { ok: true, rules: rules.map(project) }
      }
      const rule = rules.find(candidate => candidate.id === args.id)
      if (rule === undefined) {
        return { ok: false, rules: rules.map(project), error: `unknown rule '${args.id ?? ''}'` }
      }
      if (args.enabled !== undefined) rule.enabled = args.enabled
      if (args.forSeconds !== undefined) rule.forSeconds = Math.max(0, args.forSeconds)
      if (args.cooldownSeconds !== undefined) rule.cooldownSeconds = Math.max(0, args.cooldownSeconds)
      return { ok: true, rules: rules.map(project) }
    },
  })
}

/** The notification test tool. */
export function hubAlertTestTool(channels: NotifyChannel[]) {
  return defineTool({
    name: 'hub_alert_test',
    description: 'Send a test notification through the configured alert channels and report the delivery result. Use this to verify a webhook works before relying on it - an operator who never received a message cannot tell a silent rule from a broken channel. Also lists the built-in channel presets.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          outcomes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                channelId: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                status: { type: 'integer' },
                error: { type: 'string' },
              },
            },
            required: true,
          },
          presets: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; outcomes: Array<{ channelId: string; ok: boolean; status?: number; error?: string }>; presets: string[]; message?: string }) => {
        const lines = [`测试通知已发送（${value.outcomes.length} 个渠道）：`]
        for (const outcome of value.outcomes) {
          lines.push(outcome.ok
            ? `${outcome.channelId}: 成功${outcome.status !== undefined ? `（HTTP ${outcome.status}）` : ''}`
            : `${outcome.channelId}: 失败 - ${outcome.error ?? '未知错误'}`)
        }
        if (value.outcomes.length === 0) lines.push('（未配置任何通知渠道）')
        lines.push('', `可用预设：${value.presets.join(', ')}`)
        return text(lines.join('\n'))
      },
    },
    async execute() {
      const outcomes = await notifyAll(channels, {
        ruleId: 'test',
        alias: 'test-host',
        kind: 'trigger',
        title: 'test',
        value: '1',
        at: Date.now(),
      }, { message: '这是来自 dsh-ssh-hub 的测试通知（收到即表示通道正常）。' })
      return {
        ok: outcomes.every(outcome => outcome.ok),
        outcomes: outcomes.map(outcome => ({
          channelId: outcome.channelId,
          ok: outcome.ok,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        })),
        presets: NOTIFY_PRESETS.map(preset => preset.id),
      }
    },
  })
}

/** One alert event, as the tools see it. */
export interface AlertEvent {
  ruleId: string
  alias: string
  kind: 'trigger' | 'recover'
  value: string
  at: number
}

/** Project a rule onto its public shape. */
function project(rule: AlertRule): { id: string; checkId: string; forSeconds: number; cooldownSeconds: number; enabled: boolean } {
  return {
    id: rule.id,
    checkId: rule.checkId,
    forSeconds: rule.forSeconds,
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
  }
}
