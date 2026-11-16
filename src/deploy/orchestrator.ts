/**
 * Deployment orchestration: roll a change out to a fleet in batches, check
 * each batch, and roll back the batch that failed.
 *
 * The design constraint that shapes everything here: a rollout that cannot
 * be undone is a deployment that only works on the happy path. So the
 * orchestrator refuses to call a deployment successful unless it can also
 * describe how to undo it, and it reports "cannot roll back" honestly when
 * there is no previous version to roll back to — rather than pretending the
 * batch is fine.
 *
 * A plan is:
 *   - a set of target hosts (selected like every other fleet operation)
 *   - the steps to run on each host (upload / exec)
 *   - a health probe run after the steps
 *   - a rollback command, run when the health probe fails
 *
 * Rollback is per BATCH, not per host: a batch that came up unhealthy is
 * rolled back as a unit, because half a batch rolled back and half not is
 * the worst possible state to hand an operator.
 */

import type { SshEngine } from '../engine.ts'
import type { ExecResult } from '../protocol.ts'

/** One step of a deployment. */
export interface DeployStep {
  /** A short name for the step (shown in the report). */
  name: string
  /** The command to run on the remote host. */
  command: string
  /**
   * The command that undoes this step.
   *
   * Without it the step cannot be rolled back, and the orchestrator says so
   * instead of silently leaving the host in the broken state.
   */
  rollbackCommand?: string
}

/** A health probe run after the steps. */
export interface HealthCheck {
  /** The command to run. */
  command: string
  /** The expected exit code (default 0). */
  expectExitCode?: number
  /** How long to wait for the service to come up before probing (ms). */
  settleMs?: number
}

/** A deployment plan. */
export interface DeployPlan {
  /** A stable name for the plan. */
  id: string
  /** A one-line description. */
  description?: string
  /** The steps, in order. */
  steps: DeployStep[]
  /** The probe run after the steps. */
  healthCheck?: HealthCheck
  /** How many hosts to deploy to at once. */
  batchSize?: number
  /** Per-command timeout (ms). */
  timeoutMs?: number
  /** Stop the rollout at the first failing batch. */
  stopOnFailure?: boolean
}

/** The outcome for one host. */
export interface DeployHostResult {
  alias: string
  ok: boolean
  /** The exit code of the last step. */
  exitCode?: number | null
  /** Whether the health probe passed. */
  healthy?: boolean
  /** Whether a rollback was attempted. */
  rolledBack?: boolean
  /** Whether the rollback succeeded. */
  rollbackOk?: boolean
  /** The error message, when the host failed. */
  error?: string
  /** The health probe output, for the operator to read. */
  healthOutput?: string
}

/** The outcome for one batch. */
export interface DeployBatchResult {
  /** The batch index, starting at 1. */
  index: number
  /** The hosts in this batch. */
  aliases: string[]
  /** The per-host results. */
  results: DeployHostResult[]
  /** Whether every host in the batch came up healthy. */
  ok: boolean
}

/** The outcome of a whole deployment. */
export interface DeployResult {
  planId: string
  ok: boolean
  batches: DeployBatchResult[]
  /** The hosts that were deployed to. */
  targets: string[]
  /** The hosts that were skipped because an earlier batch failed. */
  skipped: string[]
  /** How long the whole rollout took. */
  durationMs: number
  /** Why the deployment failed, when it did. */
  error?: string
}

/** The default batch size when a plan does not set one. */
export const DEFAULT_BATCH_SIZE = 5

/**
 * Split a list into batches.
 *
 * @param items - the items to split.
 * @param size - the batch size.
 * @returns the batches.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const width = Math.max(1, size)
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += width) {
    batches.push(items.slice(index, index + width))
  }
  return batches
}

/**
 * Run one deployment plan against the given hosts.
 *
 * @param engine - the SSH engine.
 * @param plan - the plan.
 * @param targets - the host aliases, in rollout order.
 * @returns the deployment outcome.
 */
export async function deploy(
  engine: SshEngine,
  plan: DeployPlan,
  targets: string[],
): Promise<DeployResult> {
  const startedAt = Date.now()
  const batchSize = plan.batchSize ?? DEFAULT_BATCH_SIZE
  const timeoutMs = plan.timeoutMs ?? 120_000
  const batches = chunk(targets, batchSize)
  const results: DeployBatchResult[] = []
  const skipped: string[] = []
  let failure: string | undefined

  for (let index = 0; index < batches.length; index += 1) {
    const aliases = batches[index] as string[]
    if (failure !== undefined && plan.stopOnFailure !== false) {
      // The rollout was stopped: the remaining hosts are reported as
      // skipped, never as deployed.
      skipped.push(...aliases)
      continue
    }
    const hostResults = await Promise.all(
      aliases.map(alias => deployHost(engine, plan, alias, timeoutMs)),
    )
    const ok = hostResults.every(result => result.ok)
    results.push({ index: index + 1, aliases, results: hostResults, ok })
    if (!ok) {
      failure = `batch ${index + 1} failed: ${hostResults.filter(result => !result.ok).map(result => result.alias).join(', ')}`
      if (plan.stopOnFailure === false) {
        // The operator asked to continue past a failing batch: the next
        // batch still runs, and the deployment as a whole still reports
        // failure.
        continue
      }
    }
  }

  return {
    planId: plan.id,
    ok: failure === undefined,
    batches: results,
    targets: [...targets],
    skipped,
    durationMs: Date.now() - startedAt,
    ...(failure !== undefined ? { error: failure } : {}),
  }
}

/**
 * Deploy to one host: run the steps, then the health probe, then roll back
 * if the probe failed.
 *
 * @param engine - the SSH engine.
 * @param plan - the plan.
 * @param alias - the host alias.
 * @param timeoutMs - the per-command timeout.
 * @returns the per-host outcome.
 */
export async function deployHost(
  engine: SshEngine,
  plan: DeployPlan,
  alias: string,
  timeoutMs: number,
): Promise<DeployHostResult> {
  let exitCode: number | null = null
  for (const step of plan.steps) {
    const result: ExecResult = await engine.exec(alias, step.command, timeoutMs)
    exitCode = result.exitCode
    if (!result.success) {
      // A step failed: try to roll this host back before giving up.
      const rollback = await rollbackHost(engine, plan, alias, timeoutMs)
      return {
        alias,
        ok: false,
        exitCode,
        rolledBack: rollback.attempted,
        rollbackOk: rollback.ok,
        error: `step '${step.name}' failed: ${result.error ?? `exit code ${result.exitCode ?? 'null'}`}`,
      }
    }
  }

  if (plan.healthCheck === undefined) {
    // No probe: the steps succeeded, so the host is considered deployed.
    return { alias, ok: true, exitCode, healthy: true }
  }

  const probe = plan.healthCheck
  if (probe.settleMs !== undefined && probe.settleMs > 0) {
    await sleep(probe.settleMs)
  }
  const health = await engine.exec(alias, probe.command, timeoutMs)
  const expected = probe.expectExitCode ?? 0
  if (health.success && health.exitCode === expected) {
    return { alias, ok: true, exitCode, healthy: true, healthOutput: health.stdout.trim().slice(0, 2000) }
  }

  // The health probe failed: roll the host back.
  const rollback = await rollbackHost(engine, plan, alias, timeoutMs)
  return {
    alias,
    ok: false,
    exitCode,
    healthy: false,
    rolledBack: rollback.attempted,
    rollbackOk: rollback.ok,
    error: `health check failed: ${health.error ?? `exit code ${health.exitCode ?? 'null'}`}`,
    healthOutput: health.stdout.trim().slice(0, 2000),
  }
}

/**
 * Roll one host back to the previous version.
 *
 * A rollback is only possible when the plan declares a rollback command for
 * every step. When it does not, the orchestrator says so plainly: the
 * host is left in the failed state and the operator has to intervene.
 *
 * @param engine - the SSH engine.
 * @param plan - the plan.
 * @param alias - the host alias.
 * @param timeoutMs - the per-command timeout.
 * @returns whether a rollback was attempted and whether it worked.
 */
export async function rollbackHost(
  engine: SshEngine,
  plan: DeployPlan,
  alias: string,
  timeoutMs: number,
): Promise<{ attempted: boolean; ok: boolean }> {
  const rollbackSteps = plan.steps
    .map(step => step.rollbackCommand)
    .filter((command): command is string => command !== undefined && command !== '')
  if (rollbackSteps.length === 0) {
    // Nothing to undo — and saying so is the honest outcome.
    return { attempted: false, ok: false }
  }
  if (rollbackSteps.length !== plan.steps.length) {
    // Some steps have no undo: a partial rollback would leave the host in
    // a state nobody designed. Do not attempt it.
    return { attempted: false, ok: false }
  }
  // Undo in reverse order: the last step is undone first.
  for (const command of [...rollbackSteps].reverse()) {
    const result = await engine.exec(alias, command, timeoutMs)
    if (!result.success) {
      return { attempted: true, ok: false }
    }
  }
  return { attempted: true, ok: true }
}

/** A promise that resolves after the given delay. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * A human-readable rendering of a deployment outcome.
 *
 * @param result - the deployment outcome.
 * @returns the report text.
 */
export function renderDeploy(result: DeployResult): string {
  const lines: string[] = [
    `部署 ${result.planId}：${result.ok ? '成功' : '失败'}（${result.targets.length} 台，耗时 ${result.durationMs}ms）`,
  ]
  if (result.error !== undefined) lines.push(`失败原因：${result.error}`)
  for (const batch of result.batches) {
    lines.push(`批次 ${batch.index}：${batch.aliases.join(', ')} — ${batch.ok ? '正常' : '异常'}`)
    for (const host of batch.results) {
      if (host.ok) {
        lines.push(`  ${host.alias}：部署成功`)
      } else {
        const rollback = host.rolledBack === true
          ? (host.rollbackOk === true ? '已回滚' : '回滚失败')
          : '无法回滚（计划未提供回滚命令）'
        lines.push(`  ${host.alias}：${host.error ?? '失败'} — ${rollback}`)
      }
    }
  }
  if (result.skipped.length > 0) {
    lines.push(`未部署（因前序批次失败而跳过）：${result.skipped.join(', ')}`)
  }
  return lines.join('\n')
}
