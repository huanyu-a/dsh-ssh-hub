/**
 * Tunnel edit dialog: rename a forward, annotate it, and — for forwards this
 * plugin owns — re-point it.
 *
 * The two kinds of tunnel get different forms on purpose. A forward that
 * belongs to another process cannot be re-pointed from here (the `ssh -N -L …`
 * command line is fixed for the life of that process), so offering port fields
 * would be a promise the plugin cannot keep; only the name and remark are
 * editable, and they persist by local port instead of by tunnel id.
 */
import { useEffect, useState } from 'react'
import type { SshApi } from '../api.ts'
import type { TunnelInfo } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import css from './panel.module.css'

/** Tunnel edit dialog props. */
export interface TunnelEditDialogProps {
  api: SshApi
  /** The tunnel being edited. */
  tunnel: TunnelInfo
  onClose: () => void
  /** Receives the outcome text so the tab can announce it once. */
  onSaved: (notice: string) => void
}

/** Whether this forward can be re-pointed from the panel. */
export function isEditableRouting(tunnel: TunnelInfo): boolean {
  return tunnel.source !== 'external'
}

/** The staged form values (all strings; parsed on save). */
interface FormState {
  name: string
  description: string
  remoteHost: string
  remotePort: string
  localPort: string
}

function blankOf(tunnel: TunnelInfo): FormState {
  return {
    name: tunnel.name ?? '',
    description: tunnel.description ?? '',
    remoteHost: tunnel.remoteHost,
    remotePort: String(tunnel.remotePort),
    localPort: String(tunnel.localPort),
  }
}

/** The tunnel edit modal. */
export function TunnelEditDialog({ api, tunnel, onClose, onSaved }: TunnelEditDialogProps) {
  const [form, setForm] = useState<FormState>(() => blankOf(tunnel))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editableRouting = isEditableRouting(tunnel)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    const remotePort = Number(form.remotePort)
    const localPort = Number(form.localPort)
    if (editableRouting) {
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        setError(tt('form.portInvalid'))
        return
      }
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        setError(tt('form.portInvalid'))
        return
      }
      if (form.remoteHost.trim() === '') {
        setError(tt('tunnel.remoteHostRequired'))
        return
      }
    }
    setSaving(true)
    setError(null)
    try {
      if (!editableRouting) {
        await api.setTunnelRemark(tunnel.localPort, {
          name: form.name.trim(),
          description: form.description.trim(),
        })
        onSaved(form.name.trim() === '' && form.description.trim() === ''
          ? tt('tunnel.remarkCleared')
          : tt('tunnel.remarkSaved'))
        return
      }
      const result = await api.updateTunnel(tunnel.id, {
        // Always sent: an empty string is the explicit clear, so saving the
        // form can both set and remove a name.
        name: form.name.trim(),
        description: form.description.trim(),
        remoteHost: form.remoteHost.trim(),
        remotePort,
        localPort,
      })
      onSaved(result.restarted
        ? tt('tunnel.rebuilt', { localPort: result.tunnel.localPort })
        : tt('tunnel.updated'))
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  const titleId = 'dsh-ssh-tunnel-edit-title'

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div
        className={css.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={event => { event.stopPropagation() }}
      >
        <h3 className={css.modalTitle} id={titleId}>{tt('tunnel.editTitle', { alias: tunnel.alias })}</h3>
        <div className={css.formRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('tunnel.name')}</span>
            <input className={css.input} value={form.name} onChange={event => { set('name', event.target.value) }} />
            <span className={css.hint}>{tt('tunnel.nameHint')}</span>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{tt('tunnel.description')}</span>
            <input className={css.input} value={form.description} onChange={event => { set('description', event.target.value) }} />
            <span className={css.hint}>{tt('tunnel.descriptionHint')}</span>
          </label>
        </div>
        {editableRouting
          ? (
            <>
              <div className={css.formRow}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{tt('tunnel.remoteHost')}</span>
                  <input className={css.input} value={form.remoteHost} onChange={event => { set('remoteHost', event.target.value) }} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{tt('tunnel.remotePort')}</span>
                  <input className={css.input} type="number" min={1} max={65535} value={form.remotePort} onChange={event => { set('remotePort', event.target.value) }} />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{tt('tunnel.localPort')}</span>
                  <input className={css.input} type="number" min={1} max={65535} value={form.localPort} onChange={event => { set('localPort', event.target.value) }} />
                </label>
              </div>
              {/* Changing any of the three ports cannot be applied in place:
                  the listener is bound to the old target, so the forward is
                  rebuilt. Saying so before the click beats explaining after. */}
              <p className={css.hint}>{tt('tunnel.editRestartHint')}</p>
            </>
          )
          : <p className={css.hint}>{tt('tunnel.editExternalHint')}</p>}
        {error !== null && <p className={css.formError} role="alert">{tt('common.error', { error })}</p>}
        <div className={css.modalFooter}>
          <button type="button" className={css.ghostButton} disabled={saving} onClick={onClose}>{tt('form.cancel')}</button>
          <button type="button" className={css.primaryButton} disabled={saving} onClick={() => { void save() }}>{tt('form.save')}</button>
        </div>
      </div>
    </div>
  )
}
