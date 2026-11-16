/**
 * The logs tab: search many hosts at once and read the merged result.
 *
 * The shape follows the question an operator actually has during an incident:
 * "did this happen anywhere else?" A per-host accordion keeps that answerable
 * without losing which machine said what — a single merged stream would be
 * easier to skim and useless for attribution.
 *
 * Results are grouped by search rather than flattened, because the same
 * pattern gets re-run as an incident develops, and a flat list would interleave
 * two runs of the same query beyond recognition.
 *
 * The source selector mirrors the host's own two modes rather than inventing
 * a third: the journal (with an optional unit) or files under a directory.
 * Offering a "smart" mode that guesses would hide which command ran.
 */
import { useCallback, useEffect, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { LogSearchRow, LogSearchPayload, SshHostSummary } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Logs tab props. */
export interface LogsTabProps {
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

/** The logs tab. */
export function LogsTab({ api, active }: LogsTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[]>([])
  const [searches, setSearches] = useState<LogSearchRow[]>([])
  const [pattern, setPattern] = useState('')
  const [source, setSource] = useState<'journal' | 'files'>('journal')
  const [unit, setUnit] = useState('')
  const [directory, setDirectory] = useState('/var/log')
  const [sinceMinutes, setSinceMinutes] = useState('30')
  const [maxLines, setMaxLines] = useState('50')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openHost, setOpenHost] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      const [nextHosts, nextSearches] = await Promise.all([api.listHosts(), api.logHistory(20)])
      setHosts(nextHosts)
      setSearches(nextSearches)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    void refresh()
  }, [active, refresh])

  const submit = async (): Promise<void> => {
    if (busy) return
    setError(null)
    if (pattern.trim() === '') { setError(tt('logs.error.noPattern')); return }
    const request: LogSearchPayload = {
      pattern: pattern.trim(),
      source,
      ...(source === 'journal' && unit.trim() !== '' ? { unit: unit.trim() } : {}),
      ...(source === 'files' ? { directory: directory.trim() === '' ? '/var/log' : directory.trim() } : {}),
      ...(Number(sinceMinutes) > 0 ? { sinceSeconds: Number(sinceMinutes) * 60 } : {}),
      ...(Number(maxLines) > 0 ? { maxLinesPerHost: Number(maxLines) } : {}),
    }
    setBusy(true)
    try {
      await api.searchLogs(request, selected.length > 0 ? selected : undefined)
      setOpenHost(null)
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
      {error !== null && <div className={css.banner} data-kind="error" role="alert">{error}</div>}

      <section className={css.formCard}>
        <h3 className={css.sectionTitle}>{tt('logs.form.title')}</h3>
        <p className={css.hint}>{tt('logs.form.hint')}</p>

        <label className={css.field}>
          <span className={css.fieldLabel}>{tt('logs.form.pattern')}</span>
          <input className={css.input} value={pattern} onChange={event => { setPattern(event.target.value) }} placeholder="OutOfMemory|panic|FAILED" />
        </label>

        <div className={css.inlineRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('logs.form.source')}</span>
            <select className={css.input} value={source} onChange={event => { setSource(event.target.value === 'files' ? 'files' : 'journal') }}>
              <option value="journal">{tt('logs.source.journal')}</option>
              <option value="files">{tt('logs.source.files')}</option>
            </select>
          </label>
          {source === 'journal' && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('logs.form.unit')} <em className={css.cellMuted}>{tt('logs.form.optional')}</em></span>
              <input className={css.input} value={unit} onChange={event => { setUnit(event.target.value) }} placeholder="nginx" />
            </label>
          )}
          {source === 'files' && (
            <label className={css.field}>
              <span className={css.fieldLabel}>{tt('logs.form.directory')}</span>
              <input className={css.input} value={directory} onChange={event => { setDirectory(event.target.value) }} placeholder="/var/log" />
            </label>
          )}
        </div>

        <div className={css.inlineRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('logs.form.since')}</span>
            <input className={css.input} value={sinceMinutes} onChange={event => { setSinceMinutes(event.target.value) }} inputMode="numeric" />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('logs.form.maxLines')}</span>
            <input className={css.input} value={maxLines} onChange={event => { setMaxLines(event.target.value) }} inputMode="numeric" />
          </label>
        </div>

        <div className={css.field}>
          <span className={css.fieldLabel}>{tt('logs.form.targets')} <em className={css.cellMuted}>{tt('logs.form.targetsHint')}</em></span>
          <div className={css.chipRow}>
            {hosts.length === 0 && <span className={css.cellMuted}>{tt('logs.form.noHosts')}</span>}
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
          {busy ? tt('logs.form.running') : tt('logs.form.run')}
        </button>
      </section>

      <section>
        <h3 className={css.sectionTitle}>{tt('logs.results.title')}</h3>
        {searches.length === 0 && <p className={css.hint}>{tt('logs.results.empty')}</p>}
        {searches.map((search, index) => {
          const matches = search.hosts.reduce((total, host) => total + host.lines.length, 0)
          const failed = search.hosts.filter(host => !host.ok).length
          return (
            <div className={css.resultCard} key={`${String(search.at)}-${String(index)}`}>
              <div className={css.resultHead}>
                <code>{search.pattern}</code>
                <span className={css.cellMuted}>
                  {search.source} · {search.hosts.length} {tt('logs.results.hosts')} · {matches} {tt('logs.results.lines')}
                  {failed > 0 && <> · {failed} {tt('logs.results.failed')}</>}
                </span>
                <span className={css.cellMuted}>{stamp(search.at)}</span>
              </div>
              <div className={css.hostList}>
                {search.hosts.map(host => (
                  <div key={host.alias}>
                    <button
                      type="button"
                      className={css.hostRow}
                      onClick={() => { setOpenHost(openHost === `${String(search.at)}-${host.alias}` ? null : `${String(search.at)}-${host.alias}`) }}
                    >
                      <span className={css.badge} data-status={host.ok ? 'ok' : 'fail'}>{host.alias}</span>
                      <span className={css.cellMuted}>
                        {host.ok
                          ? <>{host.lines.length}{host.truncated ? '+' : ''} {tt('logs.results.lines')}{host.total > host.lines.length ? ` / ${String(host.total)} ${tt('logs.results.matched')}` : ''}</>
                          : (host.error ?? tt('logs.results.failed'))}
                      </span>
                    </button>
                    {openHost === `${String(search.at)}-${host.alias}` && host.lines.length > 0 && (
                      <pre className={css.logBlock}>{host.lines.join('\n')}</pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}