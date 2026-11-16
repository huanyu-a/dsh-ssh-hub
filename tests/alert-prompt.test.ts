/**
 * Alert delivery into the agent's prompt.
 *
 * The property that matters is not formatting: it is that the summary never
 * lets an empty alert list read as "healthy" when nothing is watching. A model
 * told "no alerts" by a stopped loop will tell the operator the fleet is fine,
 * and that is the single most damaging sentence this plugin can put in a
 * prompt.
 */
import { describe, expect, it } from 'vitest'
import { renderAlertSummary } from '../src/alerting/prompt-summary.ts'
import type { AlertEngine } from '../src/alerting/rules.ts'
import type { Monitor } from '../src/monitor/loop.ts'

/** A fake alert engine returning a fixed state list. */
function engineWith(rows: Array<{
  ruleId: string
  alias: string
  state: 'ok' | 'pending' | 'firing' | 'frozen'
  lastValue?: number | boolean | string | null
}>): AlertEngine {
  return { list: () => rows } as unknown as AlertEngine
}

/** A fake monitor reporting the given running flag. */
function monitorRunning(running: boolean): Monitor {
  return { status: () => ({ running }) } as unknown as Monitor
}

describe('quiet fleet', () => {
  it('says nothing when the loop is armed and nothing fires', () => {
    // Silence is the correct output: an armed, healthy fleet needs no prompt
    // budget.
    expect(renderAlertSummary(engineWith([]), monitorRunning(true))).toBe('')
  })

  it('ignores rules that are merely ok', () => {
    const engine = engineWith([{ ruleId: 'disk-full', alias: 'alpha', state: 'ok' }])
    expect(renderAlertSummary(engine, monitorRunning(true))).toBe('')
  })

  it('warns that an empty list from a stopped loop means nothing', () => {
    const summary = renderAlertSummary(engineWith([]), monitorRunning(false))
    expect(summary).not.toBe('')
    // The exact distinction must be stated, not implied.
    expect(summary).toContain('未启动')
    expect(summary).toContain('不代表健康')
  })
})

describe('firing alerts', () => {
  it('names the rule, host and value', () => {
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'tencent', state: 'firing', lastValue: '91%' },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    expect(summary).toContain('tencent')
    expect(summary).toContain('disk-full')
    expect(summary).toContain('91%')
    expect(summary).toContain('1')
  })

  it('states an unreadable value rather than printing null', () => {
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'alpha', state: 'firing', lastValue: null },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    expect(summary).toContain('—')
    expect(summary).not.toContain('null')
    expect(summary).not.toContain('undefined')
  })

  it('keeps pending separate from firing', () => {
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'alpha', state: 'firing', lastValue: 91 },
      { ruleId: 'memory-pressure', alias: 'beta', state: 'pending', lastValue: 88 },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    // A blip must not be presented as an outage, so the two counts are worded
    // separately and beta is not listed as a firing row.
    expect(summary).toContain('待确认')
    expect(summary).not.toContain('- [pending] beta')
  })

  it('reports pending alone without claiming anything is firing', () => {
    const engine = engineWith([
      { ruleId: 'memory-pressure', alias: 'beta', state: 'pending', lastValue: 88 },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    expect(summary).toContain('待确认')
    expect(summary).not.toContain('触发中')
  })

  it('bounds a fleet-wide outage and points at the tool for the rest', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ruleId: 'disk-full',
      alias: `host-${String(index)}`,
      state: 'firing' as const,
      lastValue: 95,
    }))
    const summary = renderAlertSummary(engineWith(rows), monitorRunning(true))
    expect(summary).toContain('20')
    // Eight rows are named, the remainder is summarised: a prompt that lists
    // twenty hosts per turn crowds out the conversation.
    expect(summary).toContain('hub_alerts')
    expect(summary.split('\n').filter(line => line.startsWith('- [')).length).toBeLessThanOrEqual(9)
  })

  it('warns that a stopped loop freezes the alert state it reports', () => {
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'alpha', state: 'firing', lastValue: 91 },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(false))
    expect(summary).toContain('不会自动更新')
  })

  it('does not warn about a stopped loop when the loop is armed', () => {
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'alpha', state: 'firing', lastValue: 91 },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    expect(summary).not.toContain('不会自动更新')
    expect(summary).not.toContain('未启动')
  })

  it('ignores frozen rows in the firing and pending counts', () => {
    // 'frozen' means the probe could not read the value; it is neither a
    // confirmed breach nor a confirmation of health.
    const engine = engineWith([
      { ruleId: 'disk-full', alias: 'alpha', state: 'frozen', lastValue: 91 },
    ])
    const summary = renderAlertSummary(engine, monitorRunning(true))
    expect(summary).toBe('')
  })
})