/**
 * Alert engine and notification tests.
 *
 * The engine's state machine is where a monitoring tool earns or loses
 * the operator's trust, so each of its three rules has a dedicated case:
 * consecutive rounds, null freezing, and cooldown that blocks re-entry
 * but never a recovery.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AlertEngine, type AlertRule } from '../src/alerting/rules.ts'
import { NOTIFY_PRESETS, placeholders, renderTemplate } from '../src/alerting/notify.ts'
import type { CheckResult } from '../src/inspect/checks.ts'

/** A rule with the defaults the tests use. */
function rule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'disk-full',
    checkId: 'disk-usage',
    forSeconds: 0,
    cooldownSeconds: 300,
    enabled: true,
    ...overrides,
  }
}

/** A result for one host. */
function result(value: number | null, breached: boolean, alias = 'web-01'): CheckResult {
  return { checkId: 'disk-usage', alias, value, breached, raw: String(value) }
}

/** A fresh engine in its own temp directory. */
function engine(): AlertEngine {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-alert-'))
  return new AlertEngine(join(dir, 'alerts.json'))
}

describe('AlertEngine', () => {
  it('fires on a breach', () => {
    const alerts = engine()
    const events = alerts.evaluate([rule()], [result(95, true)], 30_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('trigger')
    expect(events[0]?.alias).toBe('web-01')
  })

  it('waits for the required consecutive rounds', () => {
    const alerts = engine()
    // 120 seconds at a 30 second poll = 4 consecutive rounds.
    const strict = rule({ forSeconds: 120 })
    expect(alerts.evaluate([strict], [result(95, true)], 30_000)).toHaveLength(0)
    expect(alerts.evaluate([strict], [result(95, true)], 30_000)).toHaveLength(0)
    expect(alerts.evaluate([strict], [result(95, true)], 30_000)).toHaveLength(0)
    const events = alerts.evaluate([strict], [result(95, true)], 30_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('trigger')
  })

  it('resets the streak when the value recovers before firing', () => {
    const alerts = engine()
    const strict = rule({ forSeconds: 120 })
    alerts.evaluate([strict], [result(95, true)], 30_000)
    alerts.evaluate([strict], [result(95, true)], 30_000)
    alerts.evaluate([strict], [result(10, false)], 30_000)
    // The streak restarted: three more breaches are still not enough.
    expect(alerts.evaluate([strict], [result(95, true)], 30_000)).toHaveLength(0)
    expect(alerts.evaluate([strict], [result(95, true)], 30_000)).toHaveLength(0)
  })

  it('does not re-notify a continued breach inside the cooldown', () => {
    const alerts = engine()
    const events = alerts.evaluate([rule()], [result(95, true)], 30_000)
    expect(events).toHaveLength(1)
    expect(alerts.evaluate([rule()], [result(95, true)], 30_000)).toHaveLength(0)
    expect(alerts.evaluate([rule()], [result(95, true)], 30_000)).toHaveLength(0)
  })

  it('re-notifies after the cooldown expires', () => {
    const alerts = engine()
    const shortCooldown = rule({ cooldownSeconds: 0 })
    expect(alerts.evaluate([shortCooldown], [result(95, true)], 30_000)).toHaveLength(1)
    // A zero cooldown means the next round may re-notify.
    const events = alerts.evaluate([shortCooldown], [result(95, true)], 30_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('trigger')
  })

  it('notifies a recovery even when the alert was still cooling down', () => {
    const alerts = engine()
    alerts.evaluate([rule()], [result(95, true)], 30_000)
    // The recovery must be reported: the cooldown never suppresses it.
    const events = alerts.evaluate([rule()], [result(10, false)], 30_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('recover')
  })

  it('FREEZES the state when the value cannot be read', () => {
    const alerts = engine()
    const strict = rule({ forSeconds: 120 })
    alerts.evaluate([strict], [result(95, true)], 30_000)
    // A blind probe: the state is held, not cleared and not advanced.
    expect(alerts.evaluate([strict], [result(null, false)], 30_000)).toHaveLength(0)
    const states = alerts.list()
    expect(states[0]?.state).toBe('frozen')
  })

  it('does not report a recovery when the probe was merely blind', () => {
    const alerts = engine()
    alerts.evaluate([rule()], [result(95, true)], 30_000)
    // The value is unreadable, then healthy again: the blind round must not
    // have produced a recovery notification.
    const blind = alerts.evaluate([rule()], [result(null, false)], 30_000)
    expect(blind).toHaveLength(0)
    const recovered = alerts.evaluate([rule()], [result(10, false)], 30_000)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.kind).toBe('recover')
  })

  it('keeps firing after a blind round when the breach continues', () => {
    const alerts = engine()
    const strict = rule({ forSeconds: 120 })
    alerts.evaluate([strict], [result(95, true)], 30_000)
    alerts.evaluate([strict], [result(95, true)], 30_000)
    alerts.evaluate([strict], [result(95, true)], 30_000)
    alerts.evaluate([strict], [result(null, false)], 30_000)
    // The breach streak was preserved across the blind round.
    const events = alerts.evaluate([strict], [result(95, true)], 30_000)
    expect(events).toHaveLength(1)
  })

  it('ignores a disabled rule', () => {
    const alerts = engine()
    expect(alerts.evaluate([rule({ enabled: false })], [result(95, true)], 30_000)).toHaveLength(0)
  })

  it('scopes a rule to specific hosts', () => {
    const alerts = engine()
    const scoped = rule({ hosts: ['web-02'] })
    expect(alerts.evaluate([scoped], [result(95, true, 'web-01')], 30_000)).toHaveLength(0)
    expect(alerts.evaluate([scoped], [result(95, true, 'web-02')], 30_000)).toHaveLength(1)
  })

  it('keeps separate state per host', () => {
    const alerts = engine()
    alerts.evaluate([rule()], [result(95, true, 'web-01')], 30_000)
    // web-02 has its own state: it has never breached.
    const events = alerts.evaluate([rule()], [result(95, true, 'web-02')], 30_000)
    expect(events).toHaveLength(1)
    expect(events[0]?.alias).toBe('web-02')
  })

  it('persists its state across a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-alert-'))
    const path = join(dir, 'alerts.json')
    const first = new AlertEngine(path)
    first.evaluate([rule()], [result(95, true)], 30_000)
    // A new engine on the same file continues where the first left off.
    const second = new AlertEngine(path)
    expect(second.evaluate([rule()], [result(95, true)], 30_000)).toHaveLength(0)
    expect(second.list()[0]?.state).toBe('firing')
  })
})

describe('renderTemplate', () => {
  it('substitutes a known placeholder', () => {
    expect(renderTemplate('value is #VALUE#', { '#VALUE#': '91' })).toBe('value is 91')
  })

  it('leaves an unknown placeholder visible', () => {
    // A typo in a template must be visible, not silently blank.
    expect(renderTemplate('#NOPE# and #VALUE#', { '#VALUE#': '91' })).toBe('#NOPE# and 91')
  })
})

describe('placeholders', () => {
  it('fills the documented placeholders', () => {
    const values = placeholders({
      ruleId: 'disk-full',
      alias: 'web-01',
      kind: 'trigger',
      title: 'disk-usage',
      value: '91',
      at: Date.UTC(2026, 0, 1),
    })
    expect(values['#SERVER.ALIAS#']).toBe('web-01')
    expect(values['#RULE.ID#']).toBe('disk-full')
    expect(values['#VALUE#']).toBe('91')
    expect(values['#STATE#']).toBe('触发')
    expect(values['#TIME#']).toContain('2026-01-01')
  })
})

describe('NOTIFY_PRESETS', () => {
  it('ships presets for the common Chinese messengers', () => {
    const ids = NOTIFY_PRESETS.map(preset => preset.id)
    expect(ids).toContain('bark')
    expect(ids).toContain('telegram')
    expect(ids).toContain('lark')
    expect(ids).toContain('wecom')
  })

  it('uses the message placeholder in every preset body', () => {
    for (const preset of NOTIFY_PRESETS) {
      const body = preset.channel.body ?? ''
      if (body === '') continue
      expect(body).toContain('#MESSAGE#')
    }
  })
})
