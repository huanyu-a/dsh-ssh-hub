/**
 * Target-resolution tests for the inspection tools.
 *
 * `resolveTargets` is the guard against an inspection that silently covers
 * the whole fleet, so its selector rules are tested directly against a
 * fake host list.
 */

import { describe, expect, it } from 'vitest'
import { resolveTargets } from '../src/inspect/tools.ts'
import type { SshEngine } from '../src/engine.ts'
import type { SshHostEntry } from '../src/protocol.ts'

/** A host entry with the fields the resolver reads. */
function host(alias: string, environment?: string, tags: string[] = []): SshHostEntry {
  return {
    alias,
    host: '10.0.0.1',
    port: 22,
    user: 'root',
    auth: { kind: 'key', keyPath: '/tmp/key' },
    proxyJump: [],
    tags,
    ...(environment !== undefined ? { environment } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A fake engine exposing only the host list the resolver needs. */
function engineWith(hosts: SshHostEntry[]): SshEngine {
  return { store: { list: () => hosts } } as unknown as SshEngine
}

const FLEET = [
  host('web-01', 'prod', ['web', 'linux']),
  host('web-02', 'prod', ['web']),
  host('db-01', 'prod', ['db', 'linux']),
  host('dev-01', 'dev', ['web']),
]

describe('resolveTargets', () => {
  it('refuses to run without a selector', () => {
    expect(() => resolveTargets(engineWith(FLEET))).toThrow(/requires aliases, environment, or tags/)
    expect(() => resolveTargets(engineWith(FLEET), [], '', [])).toThrow(/requires aliases, environment, or tags/)
  })

  it('selects by explicit aliases', () => {
    const targets = resolveTargets(engineWith(FLEET), ['web-01', 'db-01'])
    expect(targets).toEqual(['web-01', 'db-01'])
  })

  it('selects by environment', () => {
    const targets = resolveTargets(engineWith(FLEET), undefined, 'prod')
    expect(targets).toEqual(['web-01', 'web-02', 'db-01'])
  })

  it('selects by tag', () => {
    const targets = resolveTargets(engineWith(FLEET), undefined, undefined, ['web'])
    expect(targets).toEqual(['web-01', 'web-02', 'dev-01'])
  })

  it('requires ALL tags to be present', () => {
    const targets = resolveTargets(engineWith(FLEET), undefined, undefined, ['web', 'linux'])
    expect(targets).toEqual(['web-01'])
  })

  it('combines selectors with AND', () => {
    const targets = resolveTargets(engineWith(FLEET), undefined, 'prod', ['web'])
    expect(targets).toEqual(['web-01', 'web-02'])
  })

  it('returns nothing when no host matches', () => {
    expect(resolveTargets(engineWith(FLEET), undefined, 'nowhere')).toEqual([])
  })
})
