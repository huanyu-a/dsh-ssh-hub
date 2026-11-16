/**
 * The deploy tab: run a rollout and read what it did.
 *
 * Two halves, deliberately in this order. The form on top is how a plan is
 * submitted; the history below is what actually happened, including runs from
 * earlier sessions. A deployment surface that only shows the result of the run
 * you just triggered cannot answer "did last night's rollout finish", which is
 * the question that matters more often.
 *
 * Every step requires its rollback command, and the form enforces it before
 * submitting. The host route refuses a plan without one too — this is the same
 * rule stated twice, because a UI that lets you compose an unrollbackable plan
 * and only fails at submit time teaches the wrong habit.
 *
 * No host picker per step: the plan is uniform across the fleet, which is what
 * makes a rollout reviewable. Per-host divergence belongs in a different tool.
 */
import { useCallback, useEffect, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { DeployPlanPayload, DeployRunRow, DeployStepPayload, SshHostSummary } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Deploy tab props. */
export interface DeployTabProps {
  /** The SSH API client. */
  api: SshApi
  /** Whether the panel is open, so refreshes only run while visible. */
  active: boolean
}

/** Format an epoch millisecond value as a short local timestamp. */
function stamp(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return new Date(ms).toLocaleString(undefined, { hour12: false })
}

/** One editable step row. */
interface StepDraft {
  name: string
  command: string
  rollbackCommand: string
}

/** A blank step the form starts from. */
const EMPTY_STEP: StepDraft = { name: '', command: '', rollbackCommand: '' }

/** The deploy tab. */
export function DeployTab({ api, active }: DeployTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [runs, setRuns] = useState<DeployRunRow[]>([])
  const [planId, setPlanId] = useState('')
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }])
  const [batchSize, setBatchSize] = useState('5')
  const [stopOnFailure, setStopOnFailure] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [healthCommand, setHealthCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const [nextHosts, nextRuns] = await Promise.all([api.listHosts(), api.deployHistory(20)])
      setHosts(nextHosts)
      setRuns(nextRuns)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh])

  /** Replace one step field without disturbing the others. */
  const editStep = (index: number, patch: Partial<StepDraft>): void => {
    setSteps(current => current.map((step, at) => (at === index ? { ...step, ...patch } : step)))
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setError(null)
    setNotice(null)
    if (planId.trim() === '') { setError(tt('deploy.error.noPlanId')); return }
    const filled = steps.filter(step => step.command.trim() !== '')
    if (filled.length === 0) { setError(tt('deploy.error.noSteps')); return }
    const unrollbackable = filled.filter(step => step.rollbackCommand.trim() === '')
    if (unrollbackable.length > 0) {
      // The host refuses this too; catching it here means the operator learns
      // the rule before a rollout is half submitted.
      setError(tt('deploy.error.noRollback'))
      return
    }
    const plan: DeployPlanPayload = {
      id: planId.trim(),
      steps: filled.map((step, index) => ({
        // A step with no name would be unidentifiable in the report.
        name: step.name.trim() === '' ? `step-${String(index + 1)}` : step.name.trim(),
        command: step.command,
        rollbackCommand: step.rollbackCommand,
      })),
      batchSize: Number(batchSize) > 0 ? Number(batchSize) : 5,
      stopOnFailure,
      ...(healthCommand.trim() === ''
        ? {}
        : { healthCheck: { command: healthCommand, expectExitCode: 0 } }),
    }
    setBusy(true)
    try {
      const run = await api.deploy(plan, selected.length > 0 ? selected : undefined)
      setNotice(tt('deploy.done').replace('{ok}', String(run.hosts.filter(host => host.ok).length)).replace('{total}', String(run.hosts.length)))
      setExpanded(run.id)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleTarget = (alias: string): void => {
    setSelected(current => (current.includes(alias) ? current.filter(item => item !== alias) : [...current, alias]))
  }

  return (
    <div className={css.panel}>
      {error !== null && <div className={css.banner} data-kind="error">{error}</div>}
      {notice !== null && <div className={css.banner} data-kind="info">{notice}</div>}

      <section className={css.formCard}>
        <h3 className={css.sectionTitle}>{tt('deploy.form.title')}</h3>
        <p className={css.hint}>{tt('deploy.form.hint')}</p>

        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('deploy.form.planId')}</span>
          <input className={css.input} value={planId} onChange={event => { setPlanId(event.target.value) }} placeholder="release-2026-11-16" />
        </label>

        {steps.map((step, index) => (
          <div className={css.stepCard} key={index}>
            <div className={css.stepHead}>
              <strong>{tt('deploy.form.step')} {index + 1}</strong>
              {steps.length > 1 && (
                <button
                  type="button"
                  className={css.linkButton}
                  onClick={() => { setSteps(current => current.filter((_, at) => at !== index)) }}
                >
                  {tt('deploy.form.removeStep')}
                </button>
              )}
            </div>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('deploy.form.stepName')}</span>
              <input className={css.input} value={step.name} onChange={event => { editStep(index, { name: event.target.value }) }} placeholder="replace-binary" />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('deploy.form.command')}</span>
              <textarea
                className={css.input}
                rows={2}
                value={step.command}
                onChange={event => { editStep(index, { command: event.target.value }) }}
                placeholder="systemctl stop app && cp new /opt/app/app && systemctl start app"
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('deploy.form.rollback')} <em className={css.cellMuted}>{tt('deploy.form.rollbackWhy')}</em></span>
              <textarea
                className={css.input}
                rows={2}
                value={step.rollbackCommand}
                onChange={event => { editStep(index, { rollbackCommand: event.target.value }) }}
                placeholder="cp /opt/app/app.prev /opt/app/app && systemctl start app"
              />
            </label>
          </div>
        ))}

        <button type="button" className={css.secondaryButton} onClick={() => { setSteps(current => [...current, { ...EMPTY_STEP }]) }}>
          {tt('deploy.form.addStep')}
        </button>

        <div className={css.inlineRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('deploy.form.batchSize')}</span>
            <input className={css.input} value={batchSize} onChange={event => { setBatchSize(event.target.value) }} inputMode="numeric" />
          </label>
          <label className={css.checkRow}>
            <input type="checkbox" checked={stopOnFailure} onChange={event => { setStopOnFailure(event.target.checked) }} />
            <span className={css.fieldLabel}>{tt('deploy.form.stopOnFailure')}</span>
          </label>
        </div>

        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('deploy.form.health')} <em className={css.cellMuted}>{tt('deploy.form.healthOptional')}</em></span>
          <input
            className={css.input}
            value={healthCommand}
            onChange={event => { setHealthCommand(event.target.value) }}
            placeholder="systemctl is-active app"
          />
        </label>

        <div className={css.field}>
          <span className={css.fieldLabel}>{tt('deploy.form.targets')} <em className={css.cellMuted}>{tt('deploy.form.targetsHint')}</em></span>
          <div className={css.chipRow}>
            {hosts.length === 0 && <span className={css.cellMuted}>{tt('deploy.form.noHosts')}</span>}
            {hosts.map(host => (
              <button
                key={host.alias}
                type="button"
                className={css.chip}
                data-selected={selected.includes(host.alias) ? 'true' : 'false'}
                onClick={() => { toggleTarget(host.alias) }}
              >
                {host.alias}
              </button>
            ))}
          </div>
        </div>

        <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { void submit() }}>
          {busy ? tt('deploy.form.running') : tt('deploy.form.run')}
        </button>
      </section>

      <section>
        <h3 className={css.sectionTitle}>{tt('deploy.history.title')}</h3>
        {runs.length === 0 && <p className={css.hint}>{tt('deploy.history.empty')}</p>}
        {runs.length > 0 && (
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{tt('deploy.col.time')}</th>
                  <th>{tt('deploy.col.plan')}</th>
                  <th>{tt('deploy.col.hosts')}</th>
                  <th>{tt('deploy.col.result')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map(run => {
                  const failed = run.hosts.filter(host => !host.ok).length
                  return (
                    <tr key={run.id}>
                      <td className={css.cellMuted}>{stamp(run.at)}</td>
                      <td>{run.planId}</td>
                      <td>
                        {run.hostCount}
                        {failed > 0 && <span className={css.cellMuted}> ({failed} {tt('deploy.col.failed')})</span>}
                      </td>
                      <td><span className={css.badge} data-status={run.ok ? 'ok' : 'fail'}>{run.ok ? tt('deploy.ok') : tt('deploy.failed')}</span></td>
                      <td>
                        <button type="button" className={css.linkButton} onClick={() => { setExpanded(expanded === run.id ? null : run.id) }}>
                          {expanded === run.id ? tt('deploy.hide') : tt('deploy.show')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {expanded !== null && (() => {
          const run = runs.find(candidate => candidate.id === expanded)
          if (run === undefined) return null
          return (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{tt('deploy.col.host')}</th>
                    <th>{tt('deploy.col.result')}</th>
                    <th>{tt('deploy.col.health')}</th>
                    <th>{tt('deploy.col.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {run.hosts.map(host => (
                    <tr key={host.alias}>
                      <td>{host.alias}</td>
                      <td><span className={css.badge} data-status={host.ok ? 'ok' : 'fail'}>{host.ok ? tt('deploy.ok') : tt('deploy.failed')}</span></td>
                      <td className={css.cellMuted}>
                        {host.healthy === undefined ? '—' : host.healthy ? tt('deploy.ok') : tt('deploy.failed')}
                      </td>
                      <td className={css.cellMuted}>
                        {host.error ?? (host.rolledBack === true ? tt('deploy.rolledBack') : '—')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })()}
      </section>
    </div>
  )
}