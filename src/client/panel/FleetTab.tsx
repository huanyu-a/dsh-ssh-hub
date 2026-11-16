/**
 * The fleet tab: one screen that answers "is anything watching the fleet,
 * and what does it see?".
 *
 * The order is deliberate. Whether the monitor is armed comes first, because
 * an operator looking at a quiet alert list needs to know whether that means
 * "all healthy" or "nothing is checking" — those look identical and mean
 * opposite things. The last round and the change set come next, then the
 * alert states, then the metric trend.
 *
 * Nothing here starts or stops the monitor: that is a config decision with
 * an audit trail, and a button in a panel is the wrong place to make it.
 * The one action is "check now", which runs the same path the timer runs.
 *
 * Styling reuses the panel's existing vocabulary (`badge` with `data-status`,
 * `banner` with `data-kind`, `cellMuted`, `hint`) rather than inventing a
 * parallel set — a second set of status colours would drift from the first.
 */
import { useCallback, useEffect, useState } from 'react'
import type { SshApi } from '../api.ts'
import type {
  AlertEventRow,
  AlertStateRow,
  HostChange,
  InspectionRound,
  MetricBucketRow,
  MonitorStatus,
  SecurityStatus,
} from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Fleet tab props. */
export interface FleetTabProps {
  /** The SSH API client. */
  api: SshApi
  /** Whether the panel is open, so refreshes only run while visible. */
  active: boolean
}

/** Format an epoch millisecond value as a short local time. */
function at(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false })
}

/** Format a value, keeping "unreadable" visibly distinct from zero. */
function value(raw: number | boolean | string | null): string {
  if (raw === null) return '—'
  if (typeof raw === 'boolean') return raw ? '是' : '否'
  return String(raw)
}

/** A tiny sparkline of the trend, drawn as text so it needs no chart library. */
function sparkline(series: MetricBucketRow[]): string {
  const bars = '▁▂▃▄▅▆▇█'
  const numeric = series.filter(bucket => bucket.value !== null).map(bucket => bucket.value as number)
  if (numeric.length < 2) return ''
  const min = Math.min(...numeric)
  const max = Math.max(...numeric)
  const span = max - min
  return numeric
    .map(item => {
      if (span === 0) return bars[0]
      const index = Math.min(bars.length - 1, Math.round(((item - min) / span) * (bars.length - 1)))
      return bars[index]
    })
    .join('')
}

/** The fleet monitoring tab. */
export function FleetTab({ api, active }: FleetTabProps) {
  const [status, setStatus] = useState<MonitorStatus | null>(null)
  const [rounds, setRounds] = useState<InspectionRound[]>([])
  const [changes, setChanges] = useState<HostChange[]>([])
  const [states, setStates] = useState<AlertStateRow[]>([])
  const [events, setEvents] = useState<AlertEventRow[]>([])
  const [security, setSecurity] = useState<SecurityStatus | null>(null)
  const [series, setSeries] = useState<MetricBucketRow[]>([])
  const [seriesHost, setSeriesHost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secretDraft, setSecretDraft] = useState('')
  const [secretBusy, setSecretBusy] = useState(false)
  const [secretNotice, setSecretNotice] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const [nextStatus, nextRounds, nextChanges, nextAlerts, nextSecurity] = await Promise.all([
        api.monitorStatus(),
        api.inspectionRounds(5),
        api.inspectionDiff(),
        api.alerts(),
        api.security(),
      ])
      setStatus(nextStatus)
      setRounds(nextRounds)
      setChanges(nextChanges)
      setStates(nextAlerts.states)
      setEvents(nextAlerts.events)
      setSecurity(nextSecurity)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh])

  const tick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.monitorTick()
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Generate a candidate secret in the browser.
   *
   * The host can generate one too, but filling the field means the operator
   * has a chance to copy it somewhere durable first — a generated key they
   * never saw is a key they cannot restore from.
   */
  const generateSecretDraft = (): string => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  const applySecret = async (): Promise<void> => {
    if (secretBusy) return
    setSecretBusy(true)
    setError(null)
    setSecretNotice(null)
    try {
      const outcome = await api.setSecret({
        action: 'set',
        ...(secretDraft.trim() === '' ? {} : { secret: secretDraft.trim() }),
      })
      if (!outcome.ok) {
        setError(outcome.error ?? tt('fleet.secretFailed'))
      } else {
        setSecretNotice(
          tt('fleet.secretSaved')
            .replace('{source}', outcome.source)
            .replace('{rotated}', String(outcome.rotated)),
        )
        setSecretDraft('')
      }
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSecretBusy(false)
    }
  }

  const clearSecret = async (): Promise<void> => {
    if (secretBusy) return
    setSecretBusy(true)
    setError(null)
    setSecretNotice(null)
    try {
      // confirmPlaintext is deliberately not sent: the host refuses to delete
      // a key while anything still depends on it, and reports why. Passing the
      // flag here would defeat that guard for the operator's most destructive
      // click.
      const outcome = await api.setSecret({ action: 'clear' })
      if (!outcome.ok) setError(outcome.error ?? tt('fleet.secretFailed'))
      else setSecretNotice(tt('fleet.secretCleared'))
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSecretBusy(false)
    }
  }

  const loadSeries = async (alias: string): Promise<void> => {    setSeriesHost(alias)
    if (alias === '') { setSeries([]); return }
    try {
      setSeries(await api.metrics(alias, '1m', 'disk-usage', 60))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const lastRound = rounds[0]
  const breached = lastRound?.results.filter(result => result.breached) ?? []
  const blind = lastRound?.results.filter(result => result.value === null) ?? []
  const hosts = lastRound?.targets ?? []
  const trend = sparkline(series)

  return (
    <div className={css.fillBody}>
      {error !== null && <div className={css.banner} data-kind="error" role="alert">{tt('common.error', { error })}</div>}
      {secretNotice !== null && <div className={css.banner} data-kind="ok" role="status">{secretNotice}</div>}

      {/* Whether anything is watching comes first: a quiet alert list and an
          armed monitor look the same until you ask. */}
      <div className={css.formCard}>
        <div className={css.toolbar}>
          <span className={css.fieldLabel}>{tt('fleet.monitor')}</span>
          <span className={css.toolbarSpacer} />
          <button type="button" className={css.primaryButton} onClick={() => { void tick() }} disabled={busy}>
            {busy ? tt('fleet.checking') : tt('fleet.checkNow')}
          </button>
        </div>
        {status === null ? (
          <div className={css.empty}>{tt('fleet.loading')}</div>
        ) : status.running ? (
          <div className={css.hint}>
            <span className={css.badge} data-status="ok">{tt('fleet.armed')}</span>
            {' '}{tt('fleet.interval')} {Math.round((status.intervalMs ?? 0) / 1000)}s
            {' · '}{status.hosts ?? 0} {tt('fleet.hosts')}
            {status.nextTickAt !== undefined && <> {' · '}{tt('fleet.nextAt')} {at(status.nextTickAt)}</>}
          </div>
        ) : (
          <div className={css.hint}>
            <span className={css.badge} data-status="pending">{tt('fleet.notArmed')}</span>
            {status.reason !== undefined && <> {status.reason}</>}
          </div>
        )}
        {security !== null && (
          <div className={css.hint}>
            {tt('fleet.security')}：
            {security.encryptConfigured && security.secret.available ? (
              <span className={css.badge} data-status="ok">{tt('fleet.encrypted')} ({security.secret.source})</span>
            ) : (
              <span className={css.badge} data-status="warn">
                {tt('fleet.plaintext')}（{security.secret.available ? tt('fleet.switchOff') : tt('fleet.noSecret')}）
              </span>
            )}
            {' · '}{tt('fleet.hostKey')} {security.hostKeyPolicy ?? '—'}
            {' · '}{tt('fleet.audit')} {security.auditEnabled === true ? tt('fleet.on') : tt('fleet.off')}
          </div>
        )}

        {/* Secret management. A master key that can only be configured by
            setting an environment variable and restarting DSH is a key most
            operators never set, so the panel offers the file-based path here.
            Rotation is stated as a consequence, not an option: changing the
            key re-encrypts every stored credential, and if that does not
            happen the credentials are lost. */}
        {security !== null && (
          <div className={css.secretCard}>
            <div className={css.toolbar}>
              <span className={css.fieldLabel}>{tt('fleet.secretTitle')}</span>
              <span className={css.toolbarSpacer} />
              <span className={css.cellMuted}>{tt('fleet.secretSource')} {security.secret.source}</span>
            </div>
            {(security.plaintextAliases ?? []).length > 0 && (
              <div className={css.banner} data-kind="warn">
                {tt('fleet.plaintextList')} {(security.plaintextAliases ?? []).join('、')}
              </div>
            )}
            {security.keyPath !== undefined && (
              <p className={css.hint}>{tt('fleet.keyPath')} <code className={css.mono}>{security.keyPath}</code></p>
            )}
            <p className={css.hint}>{tt('fleet.secretHint')}</p>
            <div className={css.inlineRow}>
              <label className={css.field}>
                <span className={css.fieldLabel}>{tt('fleet.secretInput')}</span>
                <input
                  className={css.input}
                  type="password"
                  value={secretDraft}
                  autoComplete="new-password"
                  placeholder={tt('fleet.secretPlaceholder')}
                  onChange={event => { setSecretDraft(event.target.value) }}
                />
              </label>
              <button
                type="button"
                className={css.primaryButton}
                disabled={secretBusy}
                onClick={() => { void applySecret() }}
              >
                {secretBusy ? tt('fleet.secretWorking') : tt('fleet.secretApply')}
              </button>
              <button
                type="button"
                className={css.linkButton}
                disabled={secretBusy}
                onClick={() => { setSecretDraft(generateSecretDraft()) }}
              >
                {tt('fleet.secretGenerate')}
              </button>
            </div>
            {security.secret.source === 'file' && (
              <button
                type="button"
                className={css.linkButton}
                data-danger=""
                disabled={secretBusy}
                onClick={() => { void clearSecret() }}
              >
                {tt('fleet.secretClear')}
              </button>
            )}
            {security.encryptConfigured && !security.secret.available && (
              <div className={css.banner} data-kind="error" role="alert">{tt('fleet.switchWithoutKey')}</div>
            )}
          </div>
        )}
      </div>

      {/* The last round: what it saw, with breaches and blind probes counted
          apart so "0 breaches" cannot hide a probe that saw nothing. */}
      <div className={css.formCard}>
        <div className={css.toolbar}>
          <span className={css.fieldLabel}>{tt('fleet.lastRound')}</span>
          <span className={css.toolbarSpacer} />
          {lastRound !== undefined && (
            <span className={css.hint}>
              {at(lastRound.startedAt)} · {lastRound.durationMs}ms · {hosts.length} {tt('fleet.hosts')}
            </span>
          )}
        </div>
        {lastRound === undefined ? (
          <div className={css.empty}>{tt('fleet.noRound')}</div>
        ) : (
          <>
            <div className={css.hint}>
              {tt('fleet.breaches')} {breached.length} · {tt('fleet.blind')} {blind.length}
            </div>
            {breached.length > 0 && (
              <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{tt('fleet.host')}</th>
                      <th>{tt('fleet.check')}</th>
                      <th>{tt('fleet.value')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breached.map(result => (
                      <tr key={result.alias + result.checkId}>
                        <td>{result.alias}</td>
                        <td>{result.checkId}</td>
                        <td><span className={css.badge} data-status="error">{value(result.value)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Changes: only what moved since the previous round, so a stable fleet
          produces no rows instead of the same wall of green every time. */}
      <div className={css.formCard}>
        <div className={css.toolbar}>
          <span className={css.fieldLabel}>{tt('fleet.changes')}</span>
        </div>
        {changes.length === 0 ? (
          <div className={css.empty}>{tt('fleet.noChanges')}</div>
        ) : (
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{tt('fleet.host')}</th>
                  <th>{tt('fleet.check')}</th>
                  <th>{tt('fleet.before')}</th>
                  <th>{tt('fleet.after')}</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change, index) => (
                  <tr key={change.alias + change.checkId + String(index)}>
                    <td>{change.alias}</td>
                    <td>{change.title}</td>
                    <td className={css.cellMuted}>{change.before ?? '—'}</td>
                    <td>
                      {change.stateChange === undefined
                        ? change.after
                        : (
                          <span className={css.badge} data-status={change.stateChange === 'new-breach' ? 'error' : 'ok'}>
                            {change.after}
                          </span>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Alert states. A frozen row is called out explicitly: it means the
          probe went blind, which is not the same as healthy. */}
      <div className={css.formCard}>
        <div className={css.toolbar}>
          <span className={css.fieldLabel}>{tt('fleet.alerts')}</span>
        </div>
        {states.length === 0 ? (
          <div className={css.empty}>{tt('fleet.noAlerts')}</div>
        ) : (
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th>{tt('fleet.host')}</th>
                  <th>{tt('fleet.rule')}</th>
                  <th>{tt('fleet.state')}</th>
                  <th>{tt('fleet.value')}</th>
                </tr>
              </thead>
              <tbody>
                {states.map(row => (
                  <tr key={row.ruleId + row.alias}>
                    <td>{row.alias}</td>
                    <td>{row.ruleId}</td>
                    <td>
                      <span
                        className={css.badge}
                        data-status={row.state === 'firing' ? 'error' : row.state === 'pending' ? 'warn' : row.state === 'frozen' ? 'pending' : 'ok'}
                      >
                        {row.state}
                      </span>
                    </td>
                    <td>{row.lastValue ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.length > 0 && (
          <details className={css.cellDetails}>
            <summary>{tt('fleet.events')} ({events.length})</summary>
            <table className={css.table}>
              <tbody>
                {events.map((event, index) => (
                  <tr key={event.ruleId + event.alias + String(event.at) + String(index)}>
                    <td className={css.cellMuted}>{at(event.at)}</td>
                    <td>{event.alias}</td>
                    <td>{event.ruleId}</td>
                    <td>
                      <span className={css.badge} data-status={event.kind === 'trigger' ? 'error' : 'ok'}>
                        {event.kind === 'trigger' ? tt('fleet.trigger') : tt('fleet.recover')}
                      </span>
                    </td>
                    <td>{event.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>

      {/* Trend: a text sparkline, because a chart library is a dependency
          this panel does not need to answer "is this going up?". */}
      <div className={css.formCard}>
        <div className={css.toolbar}>
          <span className={css.fieldLabel}>{tt('fleet.trend')}</span>
        </div>
        {hosts.length === 0 ? (
          <div className={css.empty}>{tt('fleet.noRound')}</div>
        ) : (
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('fleet.host')}</span>
            <select className={css.input} value={seriesHost} onChange={event => { void loadSeries(event.target.value) }}>
              <option value="">{tt('fleet.pickHost')}</option>
              {hosts.map(host => <option key={host} value={host}>{host}</option>)}
            </select>
          </label>
        )}
        {trend !== '' && (
          <div className={css.hint}>
            {tt('fleet.diskTrend')} <code className={css.mono}>{trend}</code>
            {' '}({series.length} {tt('fleet.buckets')})
          </div>
        )}
      </div>
    </div>
  )
}