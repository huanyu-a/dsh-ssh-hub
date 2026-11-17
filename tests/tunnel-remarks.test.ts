/**
 * The remarks file is the only thing that lets an operator annotate a forward
 * this plugin did not create. It is keyed by local port (a tunnel id embeds the
 * owning pid and dies with it), it must survive being hand-edited, and clearing
 * a remark has to delete the entry rather than store two empty strings — an
 * empty entry would shadow `~/.ssh/forwards.conf` forever.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTunnelRemarks, setTunnelRemark, writeTunnelRemarks } from '../src/engine/tunnel-remarks.ts'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-remarks-'))
  file = join(dir, 'tunnel-remarks.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readTunnelRemarks', () => {
  it('returns an empty map when the file does not exist', () => {
    expect(readTunnelRemarks(file)).toEqual({})
  })

  it('returns an empty map for a corrupt file instead of throwing', () => {
    writeFileSync(file, '{ not json', 'utf8')
    expect(readTunnelRemarks(file)).toEqual({})
  })

  it('returns an empty map when the JSON is not an object', () => {
    writeFileSync(file, '["7863"]', 'utf8')
    expect(readTunnelRemarks(file)).toEqual({})
  })

  it('ignores keys that are not ports and entries with nothing in them', () => {
    writeFileSync(file, JSON.stringify({
      '7863': { name: 'workbuddy-api' },
      'not-a-port': { name: 'junk' },
      '8090': {},
      '8096': { name: '   ', description: null },
    }), 'utf8')
    expect(readTunnelRemarks(file)).toEqual({ '7863': { name: 'workbuddy-api' } })
  })

  it('trims stored values', () => {
    writeFileSync(file, JSON.stringify({ '3425': { name: '  magpie-gateway  ', description: ' api ' } }), 'utf8')
    expect(readTunnelRemarks(file)).toEqual({ '3425': { name: 'magpie-gateway', description: 'api' } })
  })
})

describe('setTunnelRemark', () => {
  it('stores a pair, then replaces it wholesale', () => {
    expect(setTunnelRemark(7863, { name: 'workbuddy-api', description: 'panel backend' }, file))
      .toEqual({ name: 'workbuddy-api', description: 'panel backend' })
    // A blank field is an instruction to clear that field, not "keep it".
    expect(setTunnelRemark(7863, { name: 'workbuddy-api', description: '' }, file))
      .toEqual({ name: 'workbuddy-api' })
    expect(readTunnelRemarks(file)).toEqual({ '7863': { name: 'workbuddy-api' } })
  })

  it('deletes the entry when both fields are blank, so forwards.conf shows again', () => {
    setTunnelRemark(3425, { name: 'magpie-gateway', description: 'gateway' }, file)
    expect(setTunnelRemark(3425, { name: '', description: '' }, file)).toBeUndefined()
    expect(readTunnelRemarks(file)).toEqual({})
    // The file still exists and is valid — clearing is not corruption.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('leaves other ports untouched', () => {
    setTunnelRemark(7863, { name: 'a' }, file)
    setTunnelRemark(8090, { name: 'b' }, file)
    setTunnelRemark(7863, { name: '' }, file)
    expect(readTunnelRemarks(file)).toEqual({ '8090': { name: 'b' } })
  })

  it('rejects a port that is not a port', () => {
    expect(() => setTunnelRemark(0, { name: 'x' }, file)).toThrow(/1\.\.65535/)
    expect(() => setTunnelRemark(70000, { name: 'x' }, file)).toThrow(/1\.\.65535/)
    expect(() => setTunnelRemark(78.5, { name: 'x' }, file)).toThrow(/1\.\.65535/)
  })
})

describe('writeTunnelRemarks', () => {
  it('creates the parent directory and leaves no temp file behind', () => {
    const nested = join(dir, 'a', 'b', 'remarks.json')
    writeTunnelRemarks({ '7863': { name: 'x' } }, nested)
    expect(readTunnelRemarks(nested)).toEqual({ '7863': { name: 'x' } })
    expect(readFileSync(nested, 'utf8')).toContain('"7863"')
  })
})
