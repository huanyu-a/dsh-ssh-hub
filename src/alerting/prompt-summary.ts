/**
 * The alert summary the agent sees in its own prompt.
 *
 * A monitoring loop whose only output is a webhook is invisible to the agent
 * working in this session: it can list hosts and run commands, but it has no
 * way to know the fleet is already on fire unless it thinks to ask. This
 * renders the current alert state into the plugin's prompt section, so a
 * conversation that touches the fleet starts from the same picture the
 * operator has.
 *
 * Deliberately quiet:
 * - nothing firing, and the loop armed → one short line saying so;
 * - nothing firing, loop NOT armed → a line that says the silence means
 *   nothing, because "no alerts" and "nothing is checking" are opposite
 *   facts that look identical in an empty list;
 * - firing → the rule, the host and the value, newest first, bounded so a
 *   fleet-wide outage cannot flood the prompt.
 */

import type { AlertEngine } from './rules.ts'
import type { Monitor } from '../monitor/loop.ts'

/** How many firing alerts the prompt names before summarising the rest. */
const MAX_LISTED = 8

/**
 * Render the live alert state for the system prompt.
 *
 * @param alerts - the alert engine holding the per-rule state.
 * @param monitor - the loop, consulted only to say whether the state is being advanced.
 * @returns the summary text, or an empty string when there is nothing to say.
 */
export function renderAlertSummary(alerts: AlertEngine, monitor: Monitor): string {
  const rows = alerts.list()
  const firing = rows.filter(row => row.state === 'firing')
  const pending = rows.filter(row => row.state === 'pending')
  const running = monitor.status().running

  if (firing.length === 0 && pending.length === 0) {
    if (!running) {
      // The important line in the whole function: an empty alert list from a
      // stopped loop is not evidence of health, and a model that reads it as
      // such will confidently tell the operator the fleet is fine.
      return '机群告警：无。注意 —— 监控循环当前未启动，这个「无」不代表健康。用 hub_monitor 查看状态。'
    }
    return ''
  }

  const lines: string[] = []
  if (firing.length > 0) {
    lines.push(`机群告警：${String(firing.length)} 条触发中。`)
    for (const row of firing.slice(0, MAX_LISTED)) {
      const value = row.lastValue === undefined || row.lastValue === null ? '—' : String(row.lastValue)
      lines.push(`- [${row.state}] ${row.alias} · ${row.ruleId} = ${value}`)
    }
    if (firing.length > MAX_LISTED) {
      lines.push(`- …另有 ${String(firing.length - MAX_LISTED)} 条，用 hub_alerts 查看全部。`)
    }
  }
  if (pending.length > 0) {
    // Pending is stated separately: it is not a failure yet, and folding it
    // into "firing" would teach the model to report a blip as an outage.
    lines.push(`另有 ${String(pending.length)} 条处于待确认（连续超限次数未达阈值）。`)
  }
  if (!running) {
    // Alerts advanced by a manual hub_inspect are real but frozen: they stop
    // updating until the loop runs again, and recovery will not be noticed.
    lines.push('注意 —— 监控循环未启动，以上状态不会自动更新，恢复也不会被发现。')
  }
  return lines.join('\n')
}