/**
 * The tunnel editor's form-to-patch step.
 *
 * The point of these cases is the inherited field: the row shows a name that
 * `forwards.conf` owns, and saving the form untouched must not quietly transfer
 * ownership of it to the tunnel record.
 */
import { describe, expect, it } from 'vitest'
import { tunnelTextPatch } from '../src/client/panel/tunnel-form.ts'
import type { TunnelInfo } from '../src/protocol.ts'

function tunnel(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 't1',
    alias: 'tencent',
    localPort: 7863,
    remoteHost: '127.0.0.1',
    remotePort: 7863,
    state: 'forwarding',
    startedAt: 0,
    ...overrides,
  }
}

describe('tunnelTextPatch', () => {
  it('submits what the operator typed when nothing is inherited', () => {
    const patch = tunnelTextPatch(
      tunnel({ name: 'old', description: 'old note' }),
      { name: '  new  ', description: ' new note ' },
    )
    expect(patch).toEqual({ name: 'new', description: 'new note' })
  })

  it('clears a name the operator emptied on purpose', () => {
    const patch = tunnelTextPatch(tunnel({ name: 'old' }), { name: '', description: '' })
    expect(patch).toEqual({ name: '', description: '' })
  })

  it('leaves an untouched inherited name inherited', () => {
    // The row shows "workbuddy-api" because forwards.conf supplies it; the
    // record itself has no name. Saving must not pin it.
    const patch = tunnelTextPatch(
      tunnel({ name: 'workbuddy-api', nameInherited: true }),
      { name: 'workbuddy-api', description: '' },
    )
    expect(patch.name).toBe('')
  })

  it('still takes over when an inherited name is actually changed', () => {
    const patch = tunnelTextPatch(
      tunnel({ name: 'workbuddy-api', nameInherited: true }),
      { name: 'workbuddy-api-v2', description: '' },
    )
    expect(patch.name).toBe('workbuddy-api-v2')
  })

  it('keeps the description independent of the name', () => {
    // Only the name is inherited here. Touching the description must not clear
    // the name, and saving the inherited name must not clear the description.
    const patch = tunnelTextPatch(
      tunnel({ name: 'workbuddy-api', nameInherited: true, description: 'panel backend' }),
      { name: 'workbuddy-api', description: 'panel backend' },
    )
    expect(patch).toEqual({ name: '', description: 'panel backend' })
  })

  it('leaves an untouched inherited description inherited', () => {
    const patch = tunnelTextPatch(
      tunnel({ name: 'n', description: 'from conf', descriptionInherited: true }),
      { name: 'n', description: 'from conf' },
    )
    expect(patch).toEqual({ name: 'n', description: '' })
  })

  it('treats surrounding whitespace as no change to an inherited value', () => {
    const patch = tunnelTextPatch(
      tunnel({ description: 'from conf', descriptionInherited: true }),
      { name: '', description: '  from conf  ' },
    )
    expect(patch.description).toBe('')
  })

  it('treats whitespace-only input on a non-inherited field as a clear', () => {
    const patch = tunnelTextPatch(tunnel({ name: 'old' }), { name: '   ', description: '   ' })
    expect(patch).toEqual({ name: '', description: '' })
  })
})
