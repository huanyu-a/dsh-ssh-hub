/**
 * Deployment orchestration tests.
 *
 * The orchestrator is exercised against a fake engine that records the
 * commands it was asked to run, so the batch / health-check / rollback
 * sequencing is verified without a server.
 */

import { describe, expect, it } from 'vitest'
import {
  chunk,
  deploy,
  deployHost,
  type DeployPlan,
  renderDeploy,
} from '../src/deploy/orchestrator.ts'
import type { SshEngine } from '../src/engine.ts'
import type { ExecResult } from '../src/protocol.ts'

/** A scripted response for one command. */
interface Response {
  /** Match the command against this substring. */
  match: string
  /** The result to return. */
  result: Partial<ExecResult>
}

/** A fake engine that records every command and replays scripted results. */
function fakeEngine(responses: Response[]): { engine: SshEngine; commands: string[] } {
  const commands: string[] = []
  const engine = {
    exec: async (alias: string, command: string): Promise<ExecResult> => {
      commands.push(`${alias}:${command}`)
      const hit = responses.find(response => command.includes(response.match))
      return {
        success: hit?.result.success ?? true,
        exitCode: hit?.result.exitCode ?? 0,
        timedOut: hit?.result.timedOut ?? false,
        stdout: hit?.result.stdout ?? '',
        stderr: hit?.result.stderr ?? '',
        durationMs: 10,
        ...(hit?.result.error !== undefined ? { error: hit.result.error } : {}),
      }
    },
  } as unknown as SshEngine
  return { engine, commands }
}

/** A plan with one deploy step and one health probe. */
function plan(overrides: Partial<DeployPlan> = {}): DeployPlan {
  return {
    id: 'release-1',
    steps: [{ name: 'deploy', command: 'deploy.sh', rollbackCommand: 'rollback.sh' }],
    healthCheck: { command: 'curl -fsS localhost:8080/health' },
    batchSize: 2,
    timeoutMs: 5000,
    ...overrides,
  }
}

describe('chunk', () => {
  it('splits into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('never produces an empty batch', () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]])
  })
})

describe('deployHost', () => {
  it('succeeds when the steps and the probe pass', async () => {
    const { engine } = fakeEngine([])
    const result = await deployHost(engine, plan(), 'web-01', 5000)
    expect(result.ok).toBe(true)
    expect(result.healthy).toBe(true)
    expect(result.rolledBack).toBeUndefined()
  })

  it('rolls back when the health probe fails', async () => {
    const { engine, commands } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1, stderr: 'connection refused' } },
    ])
    const result = await deployHost(engine, plan(), 'web-01', 5000)
    expect(result.ok).toBe(false)
    expect(result.healthy).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.rollbackOk).toBe(true)
    expect(commands).toContain('web-01:rollback.sh')
  })

  it('rolls back in reverse order', async () => {
    const { engine, commands } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const multi = plan({
      steps: [
        { name: 'a', command: 'step-a', rollbackCommand: 'undo-a' },
        { name: 'b', command: 'step-b', rollbackCommand: 'undo-b' },
      ],
    })
    await deployHost(engine, multi, 'web-01', 5000)
    expect(commands.indexOf('web-01:undo-b')).toBeLessThan(commands.indexOf('web-01:undo-a'))
  })

  it('reports honestly when there is nothing to roll back to', async () => {
    const { engine } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const noRollback = plan({
      steps: [{ name: 'deploy', command: 'deploy.sh' }],
    })
    const result = await deployHost(engine, noRollback, 'web-01', 5000)
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(false)
    expect(result.rollbackOk).toBe(false)
  })

  it('refuses a partial rollback', async () => {
    const { engine, commands } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const partial = plan({
      steps: [
        { name: 'a', command: 'step-a', rollbackCommand: 'undo-a' },
        { name: 'b', command: 'step-b' },
      ],
    })
    const result = await deployHost(engine, partial, 'web-01', 5000)
    expect(result.rolledBack).toBe(false)
    // A half-applied rollback would leave the host in an undesigned state.
    expect(commands).not.toContain('web-01:undo-a')
  })

  it('rolls back when a step itself fails', async () => {
    const { engine, commands } = fakeEngine([
      { match: 'deploy.sh', result: { success: false, exitCode: 2, error: 'checksum mismatch' } },
    ])
    const result = await deployHost(engine, plan(), 'web-01', 5000)
    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(commands).toContain('web-01:rollback.sh')
  })

  it('reports a failed rollback', async () => {
    const { engine } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
      { match: 'rollback.sh', result: { success: false, exitCode: 3, error: 'no previous version' } },
    ])
    const result = await deployHost(engine, plan(), 'web-01', 5000)
    expect(result.rolledBack).toBe(true)
    expect(result.rollbackOk).toBe(false)
  })
})

describe('deploy', () => {
  it('rolls out in batches', async () => {
    const { engine } = fakeEngine([])
    const result = await deploy(engine, plan({ batchSize: 2 }), ['a', 'b', 'c', 'd', 'e'])
    expect(result.ok).toBe(true)
    expect(result.batches).toHaveLength(3)
    expect(result.batches[0]?.aliases).toEqual(['a', 'b'])
    expect(result.batches[2]?.aliases).toEqual(['e'])
  })

  it('stops at the first failing batch and skips the rest', async () => {
    const { engine } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const result = await deploy(engine, plan({ batchSize: 2 }), ['a', 'b', 'c', 'd'])
    expect(result.ok).toBe(false)
    expect(result.batches).toHaveLength(1)
    // c and d were never touched, and are reported as skipped.
    expect(result.skipped).toEqual(['c', 'd'])
  })

  it('can continue past a failing batch when asked', async () => {
    const { engine } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const result = await deploy(engine, plan({ batchSize: 2, stopOnFailure: false }), ['a', 'b', 'c', 'd'])
    expect(result.ok).toBe(false)
    expect(result.batches).toHaveLength(2)
  })

  it('rolls back the failing batch', async () => {
    const { engine, commands } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    await deploy(engine, plan({ batchSize: 2 }), ['a', 'b'])
    expect(commands).toContain('a:rollback.sh')
    expect(commands).toContain('b:rollback.sh')
  })
})

describe('renderDeploy', () => {
  it('says that a rollback was impossible rather than hiding it', async () => {
    const { engine } = fakeEngine([
      { match: 'curl', result: { success: false, exitCode: 1 } },
    ])
    const result = await deploy(engine, plan({ steps: [{ name: 'd', command: 'deploy.sh' }] }), ['a'])
    const report = renderDeploy(result)
    expect(report).toContain('无法回滚')
    expect(report).toContain('失败')
  })

  it('reports a successful rollout', async () => {
    const { engine } = fakeEngine([])
    const report = renderDeploy(await deploy(engine, plan(), ['a', 'b']))
    expect(report).toContain('成功')
    expect(report).toContain('a、b'.replace('、', ', '))
  })
})
