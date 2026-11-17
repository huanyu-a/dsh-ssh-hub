/**
 * Editing a tunnel is two different operations wearing one name. Renaming is a
 * metadata change that must never interrupt traffic; re-pointing is a rebuild,
 * because the listener is bound to the old target. These tests pin that split,
 * and pin what happens when the rebuild itself fails: the old forward is gone
 * and the error has to say so instead of reading like a failed connect.
 */
import { describe, expect, it } from 'vitest'
import { updateTunnel, type TunnelRecord } from '../src/engine/tunnel.ts'
import type { TunnelInfo } from '../src/protocol.ts'

function makeTunnel(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 't1',
    alias: 'tencent',
    localPort: 7863,
    remoteHost: '127.0.0.1',
    remotePort: 7863,
    state: 'forwarding',
    startedAt: 1,
    ...overrides,
  }
}

/**
 * The smallest engine an edit needs: a tunnel registry, a pool, and a store
 * with no hosts — so a rebuild path reaches startTunnel and fails there, which
 * is exactly the failure these tests are about.
 */
function makeEngine(info: TunnelInfo): { engine: never; record: TunnelRecord; closed: () => number } {
  let closes = 0
  const record = {
    info,
    server: { close: () => { closes += 1 } },
    alias: info.alias,
    record: { client: { end: () => { closes += 1 } }, hops: [] },
    sockets: new Set(),
  } as unknown as TunnelRecord
  const engine = {
    tunnels: new Map([[info.id, record]]),
    nextTunnelId: 2,
    pool: new Map(),
    store: { find: () => undefined },
    opts: {},
  } as never
  return { engine, record, closed: () => closes }
}

describe('updateTunnel — metadata', () => {
  it('renames in place without touching the listener', async () => {
    const { engine, record, closed } = makeEngine(makeTunnel())
    const result = await updateTunnel(engine, 't1', { name: 'workbuddy-api', description: 'panel backend' })
    expect(result.restarted).toBe(false)
    expect(result.tunnel.name).toBe('workbuddy-api')
    expect(result.tunnel.description).toBe('panel backend')
    expect(result.tunnel.localPort).toBe(7863)
    expect(record.info.name).toBe('workbuddy-api')
    // Nothing was closed: a rename must not drop live connections.
    expect(closed()).toBe(0)
  })

  it('clears a name with an empty string so forwards.conf can show through again', async () => {
    const { engine, record } = makeEngine(makeTunnel({ name: 'typed here', description: 'note' }))
    const result = await updateTunnel(engine, 't1', { name: '   ' })
    expect(result.tunnel.name).toBeUndefined()
    expect(record.info.name).toBeUndefined()
    // An omitted field keeps its value; only the one addressed was cleared.
    expect(result.tunnel.description).toBe('note')
  })

  it('returns a new object rather than mutating the snapshot a caller holds', async () => {
    const info = makeTunnel({ name: 'before' })
    const { engine } = makeEngine(info)
    const result = await updateTunnel(engine, 't1', { name: 'after' })
    expect(result.tunnel).not.toBe(info)
    expect(info.name).toBe('before')
  })

  it('keeps the routing fields when only the name changes', async () => {
    const { engine } = makeEngine(makeTunnel({ remoteHost: '10.0.0.5', remotePort: 5432, localPort: 15432 }))
    const result = await updateTunnel(engine, 't1', { name: 'db' })
    expect(result.tunnel.remoteHost).toBe('10.0.0.5')
    expect(result.tunnel.remotePort).toBe(5432)
    expect(result.tunnel.localPort).toBe(15432)
  })
})

describe('updateTunnel — validation', () => {
  it('refuses an unknown tunnel', async () => {
    const { engine } = makeEngine(makeTunnel())
    await expect(updateTunnel(engine, 'nope', { name: 'x' })).rejects.toThrow(/not found/)
  })

  it('refuses a port outside 1..65535', async () => {
    const { engine } = makeEngine(makeTunnel())
    await expect(updateTunnel(engine, 't1', { remotePort: 0 })).rejects.toThrow(/remotePort/)
    await expect(updateTunnel(engine, 't1', { remotePort: 70000 })).rejects.toThrow(/remotePort/)
    await expect(updateTunnel(engine, 't1', { localPort: 1.5 })).rejects.toThrow(/localPort/)
  })

  it('refuses an empty remote host', async () => {
    const { engine } = makeEngine(makeTunnel())
    await expect(updateTunnel(engine, 't1', { remoteHost: '  ' })).rejects.toThrow(/remoteHost/)
  })
})

describe('updateTunnel — rebuild', () => {
  it('tears the old forward down when the routing changes', async () => {
    const { engine, closed } = makeEngine(makeTunnel())
    // The stub store has no hosts, so the rebuild itself cannot succeed — the
    // point here is that the old listener was closed and the failure is named.
    await expect(updateTunnel(engine, 't1', { remotePort: 9999 }))
      .rejects.toThrow(/could not be rebuilt.*previous forward was closed/s)
    expect(closed()).toBeGreaterThan(0)
  })

  it('removes the old record before rebuilding, so no stale entry survives', async () => {
    const { engine } = makeEngine(makeTunnel())
    const map = (engine as unknown as { tunnels: Map<string, TunnelRecord> }).tunnels
    await expect(updateTunnel(engine, 't1', { localPort: 17863 })).rejects.toThrow()
    expect(map.has('t1')).toBe(false)
  })
})
