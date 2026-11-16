/**
 * Diagnostics kept as regression tests.
 *
 * Both cases below were real failures: the first round against a real fleet
 * took the whole monitoring loop down because one host in the store was
 * unreachable, and nothing said why (the webserver turns a thrown route
 * handler into an empty 400). They now assert the behaviour that fix
 * introduced, so the loop cannot regress to "one dead box blinds the fleet".
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Inspector } from '../src/inspect/inspection.ts'
import { AlertEngine } from '../src/alerting/rules.ts'
import { defaultRules } from '../src/alerting/tools.ts'
import { Monitor } from '../src/monitor/loop.ts'
import type { SshEngine } from '../src/engine.ts'

/** An engine that returns a fixed stdout per command. */
function healthy(value: string): SshEngine {
  return {
    exec: async () => ({ success: true, exitCode: 0, timedOut: false, stdout: value, stderr: '', durationMs: 1 }),
  } as unknown as SshEngine
}

/**
 * An engine where one alias fails and the rest answer.
 *
 * This is the common real case: a host that is rebooting while the timer
 * fires.
 */
function partiallyDown(alias: string, value: string): SshEngine {
  return {
    exec: async (target: string) => {
      if (target === alias) throw new Error(`connect ECONNREFUSED ${target}:22`)
      return { success: true, exitCode: 0, timedOut: false, stdout: value, stderr: '', durationMs: 1 }
    },
  } as unknown as SshEngine
}

/**
 * Answer one command with a value that is healthy under its own check.
 *
 * Deriving the answer from the check table (rather than hard-coding `'10'`
 * for everything) keeps the mock aligned with the real parsers: each check
 * has its own scale, so a single number is out of range for at least one of
 * them and the test fails for the wrong reason.
 */
function healthyAnswer(command: string): string {
  if (command.includes('df -P')) return '10'          // disk-usage, above 85
  if (command.includes('df -i')) return '10'          // disk-inodes, above 85
  if (command.includes('/proc/loadavg')) return '0.1' // load-average, above 4
  if (command.includes('/proc/uptime')) return '90000' // uptime, below 3600
  if (command.includes('free')) return '10'          // memory-used, above 90
  if (command.includes('--failed')) return '0'        // failed-units, above 0
  if (command.includes('pgrep')) return 'running'     // sshd-running, wants 'running'
  if (command.includes('uname')) return 'Linux 6.1.0-verify' // kernel, text only
  return ''
}

describe('tick with a real alert engine and a real inspector', () => {
  it('does not throw when a round produces a breach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag-'))
    const inspector = new Inspector(join(dir, 'inspection.jsonl'))
    // The engine answers every command with a high disk number, so the
    // disk-usage check breaches and the alert engine has work to do.
    const alerts = new AlertEngine(join(dir, 'alerts.json'))
    const monitor = new Monitor(healthy('93'), inspector, alerts, [], {
      intervalMs: 60_000,
      rules: defaultRules(),
      targets: () => ['h1'],
    })
    const tick = await monitor.tick()
    expect(tick?.ran).toBe(true)
    expect(tick?.breaches).toBeGreaterThan(0)
  })

  it('survives a state directory that does not exist yet', async () => {
    // A brand-new profile has no $DSH_HOME/dsh-ssh-hub directory; the first
    // round must create it rather than fail.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag2-'))
    const nested = join(dir, 'dsh-ssh-hub')
    const inspector = new Inspector(join(nested, 'inspection.jsonl'))
    const alerts = new AlertEngine(join(nested, 'alerts.json'))
    const monitor = new Monitor(healthy('93'), inspector, alerts, [], {
      intervalMs: 60_000,
      rules: defaultRules(),
      targets: () => ['h1'],
    })
    const tick = await monitor.tick()
    expect(tick?.ran).toBe(true)
  })
})

describe('one unreachable host does not blind the fleet', () => {
  it('records the failure as a blind result for that host only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag3-'))
    const inspector = new Inspector(join(dir, 'inspection.jsonl'))
    const round = await inspector.run(partiallyDown('dead', '93'), ['dead', 'alive'])
    // Both hosts are in the round: the dead one must not vanish from the
    // report, or the operator would read "2 hosts inspected, 2 healthy".
    expect(round.targets).toEqual(['dead', 'alive'])
    const dead = round.results.filter(result => result.alias === 'dead')
    const alive = round.results.filter(result => result.alias === 'alive')
    expect(dead.length).toBeGreaterThan(0)
    expect(alive.length).toBeGreaterThan(0)
    // Every dead result carries the connection error and no value.
    expect(dead.every(result => result.value === null && typeof result.error === 'string')).toBe(true)
    // The live host still reported real values.
    expect(alive.some(result => result.value === 93)).toBe(true)
  })

  it('keeps the monitoring loop running when a host is down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag4-'))
    const inspector = new Inspector(join(dir, 'inspection.jsonl'))
    const alerts = new AlertEngine(join(dir, 'alerts.json'))
    const monitor = new Monitor(partiallyDown('dead', '93'), inspector, alerts, [], {
      intervalMs: 60_000,
      rules: defaultRules(),
      targets: () => ['dead', 'alive'],
    })
    const tick = await monitor.tick()
    // The round completed instead of throwing, and it counted the blind
    // probes rather than pretending they were healthy.
    expect(tick?.ran).toBe(true)
    expect(tick?.hosts).toBe(2)
    expect(tick?.blind).toBeGreaterThan(0)
  })

  it('still reports a healthy host as healthy when another host is down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-diag5-'))
    const inspector = new Inspector(join(dir, 'inspection.jsonl'))
    const alerts = new AlertEngine(join(dir, 'alerts.json'))
    // A low value for every numeric check: disk at 10% and load at 10 are
    // different scales, so this engine answers per command rather than with
    // one number. Only disk-usage matters here.
    const low = {
      exec: async (target: string, command: string) => {
        if (target === 'dead') throw new Error('connect ECONNREFUSED dead:22')
        return {
          success: true,
          exitCode: 0,
          timedOut: false,
          stdout: healthyAnswer(command),
          stderr: '',
          durationMs: 1,
        }
      },
    } as unknown as SshEngine
    const monitor = new Monitor(low, inspector, alerts, [], {
      intervalMs: 60_000,
      rules: defaultRules(),
      targets: () => ['dead', 'alive'],
    })
    const tick = await monitor.tick()
    // Disk at 10% is under every watermark and load at 0.1 is under its own,
    // so no alert fires; the dead host yields blind results, not breaches.
    // The assertion names the offending checks when it fails, so a future
    // threshold change reports which check moved instead of just a count.
    const breached = monitor.lastRound?.results.filter(result => result.breached && result.alias === 'alive') ?? []
    expect(breached.map(result => `${result.checkId}=${String(result.value)}`)).toEqual([])
    expect(tick?.breaches).toBe(0)
    expect(tick?.blind).toBeGreaterThan(0)
  })
})