/**
 * Agent tool for deployment orchestration.
 *
 * The tool is deliberately plan-driven: the agent supplies the steps, the
 * health probe and the rollback commands, and the orchestrator runs them in
 * batches. A tool that invented a deployment shape would be a tool that
 * deployed the wrong thing confidently.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from '../engine.ts'
import { deploy, renderDeploy, type DeployPlan } from './orchestrator.ts'
import type { AuditRecorder } from '../audit/recorder.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** The deployment tool. */
export function hubDeployTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'hub_deploy',
    description: 'Roll a change out to selected SSH hosts in batches, run a health probe after each batch, and roll the batch back when the probe fails. Every step needs a rollbackCommand to be undoable; without one the tool reports honestly that the host cannot be rolled back instead of pretending it is fine. Use ssh_cluster for a one-off command across hosts; use hub_deploy when the change must be verified and undone on failure.',
    parameters: {
      planId: { type: 'string', required: true, description: 'A short name for this deployment, e.g. release-2026-11-16.' },
      steps: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            command: { type: 'string', required: true },
            rollbackCommand: { type: 'string' },
          },
        },
        description: 'The steps to run on each host, in order. Give each one a rollbackCommand so a failed host can be undone.',
      },
      healthCheckCommand: { type: 'string', description: 'The command that verifies the host came up healthy (exit code 0 = healthy). Omit to trust the steps alone.' },
      healthCheckExpectExitCode: { type: 'integer', description: 'The exit code that means healthy (default 0).' },
      healthCheckSettleMs: { type: 'integer', description: 'How long to wait before probing, so the service can start (default 0).' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Host aliases to deploy to. Optional when environment or tags is given.' },
      environment: { type: 'string', description: 'Deploy only to hosts with this environment label (exact match).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Deploy only to hosts carrying ALL of these tags.' },
      batchSize: { type: 'integer', description: 'How many hosts to deploy to at once (default 5).' },
      timeoutMs: { type: 'integer', description: 'Per-command timeout in milliseconds (default 120000).' },
      stopOnFailure: { type: 'boolean', description: 'Stop the rollout at the first failing batch (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          planId: { type: 'string', required: true },
          targets: { type: 'array', items: { type: 'string' }, required: true },
          skipped: { type: 'array', items: { type: 'string' }, required: true },
          batches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                aliases: { type: 'array', items: { type: 'string' }, required: true },
                ok: { type: 'boolean', required: true },
              },
            },
          },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; planId: string; targets: string[]; skipped: string[]; batches: Array<{ index: number; aliases: string[]; ok: boolean }>; durationMs: number; error?: string }) => {
        const lines = [
          `部署 ${value.planId}：${value.ok ? '成功' : '失败'}（${value.targets.length} 台，耗时 ${value.durationMs}ms）`,
        ]
        if (value.error !== undefined) lines.push(`失败原因：${value.error}`)
        for (const batch of value.batches) {
          lines.push(`批次 ${batch.index}：${batch.aliases.join(', ')} — ${batch.ok ? '正常' : '异常'}`)
        }
        if (value.skipped.length > 0) {
          lines.push(`未部署（因前序批次失败而跳过）：${value.skipped.join(', ')}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const targets = resolveDeployTargets(engine, toStringArray(args.aliases), args.environment, toStringArray(args.tags))
      const steps = toSteps(args.steps)
      if (steps.length === 0) {
        throw new Error('hub_deploy requires at least one step')
      }
      const plan: DeployPlan = {
        id: args.planId,
        steps,
        batchSize: args.batchSize ?? 5,
        timeoutMs: args.timeoutMs ?? 120_000,
        ...(args.healthCheckCommand !== undefined
          ? {
            healthCheck: {
              command: args.healthCheckCommand,
              ...(args.healthCheckExpectExitCode !== undefined ? { expectExitCode: args.healthCheckExpectExitCode } : {}),
              ...(args.healthCheckSettleMs !== undefined ? { settleMs: args.healthCheckSettleMs } : {}),
            },
          }
          : {}),
        ...(args.stopOnFailure !== undefined ? { stopOnFailure: args.stopOnFailure } : {}),
      }
      const result = await deploy(engine, plan, targets)
      audit?.record('deploy', {
        ok: result.ok,
        targets: result.targets,
        summary: `deploy ${result.planId}: ${result.ok ? 'ok' : 'failed'}`,
        detail: {
          batches: result.batches.length,
          failedHosts: result.batches.flatMap(batch => batch.results.filter(host => !host.ok).map(host => host.alias)),
          rolledBack: result.batches.flatMap(batch => batch.results.filter(host => host.rolledBack === true).map(host => host.alias)),
          skipped: result.skipped,
        },
      })
      return {
        ok: result.ok,
        planId: result.planId,
        targets: result.targets,
        skipped: result.skipped,
        batches: result.batches.map(batch => ({
          index: batch.index,
          aliases: batch.aliases,
          ok: batch.ok,
        })),
        durationMs: result.durationMs,
        ...(result.error !== undefined ? { error: result.error } : {}),
      }
    },
  })
}

/**
 * Resolve the hosts to deploy to.
 *
 * An empty selector is refused: deploying to an unspecified set of hosts
 * is the most expensive possible mistake.
 *
 * @param engine - the SSH engine.
 * @param aliases - explicit aliases.
 * @param environment - an environment label.
 * @param tags - tags that must all be present.
 * @returns the selected aliases.
 */
function resolveDeployTargets(
  engine: SshEngine,
  aliases?: string[],
  environment?: string,
  tags?: string[],
): string[] {
  const hasAlias = aliases !== undefined && aliases.length > 0
  const hasEnvironment = environment !== undefined && environment !== ''
  const hasTags = tags !== undefined && tags.length > 0
  if (!hasAlias && !hasEnvironment && !hasTags) {
    throw new Error('hub_deploy requires aliases, environment, or tags to limit the target set')
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
    hosts = hosts.filter(host => wanted.every(tag => host.tags.includes(tag)))
  }
  return hosts.map(host => host.alias)
}

// `renderDeploy` is exported for callers that want the full report text
// (the panel uses it); the tool renders a compact summary.
export { renderDeploy }

/**
 * Narrow a tool argument to a string array.
 *
 * @param value - the raw argument.
 * @returns the strings, or undefined when the value is absent or unusable.
 */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return strings.length === 0 ? undefined : strings
}

/**
 * Narrow the steps argument to the deploy-step shape.
 *
 * A malformed step is dropped rather than passed on: a step without a
 * command cannot run, and running a half-specified step is worse than
 * reporting that the plan is malformed.
 *
 * @param value - the raw argument.
 * @returns the usable steps.
 */
function toSteps(value: unknown): Array<{ name: string; command: string; rollbackCommand?: string }> {
  if (!Array.isArray(value)) return []
  const steps: Array<{ name: string; command: string; rollbackCommand?: string }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const command = record['command']
    if (typeof command !== 'string' || command.trim() === '') continue
    const name = record['name']
    const rollback = record['rollbackCommand']
    steps.push({
      name: typeof name === 'string' && name !== '' ? name : command.slice(0, 40),
      command,
      ...(typeof rollback === 'string' && rollback !== '' ? { rollbackCommand: rollback } : {}),
    })
  }
  return steps
}
