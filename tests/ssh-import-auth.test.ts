/**
 * ssh_config import fidelity and forward discovery.
 *
 * These cover the two ways a host that works with plain `ssh <alias>` used to
 * fail inside the plugin: a multi-`IdentityFile` block collapsed to its last
 * key, and `PreferredAuthentications none` imported as a password host with no
 * password. Both failures look like "this plugin cannot read my local SSH
 * config" even though the file parsed fine.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostStore, keyCandidates, prefersNone } from '../src/store.ts'
import { parseForwardSpec, parseSshArguments, splitCommandLine } from '../src/engine/tunnel-discovery.ts'

/** Build a store whose ssh_config is a fresh temp file with `text`. */
function storeWithConfig(text: string): HostStore {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-'))
  const config = join(dir, 'config')
  writeFileSync(config, text, 'utf8')
  return new HostStore(join(dir, 'dsh-ssh.json'), config)
}

describe('ssh_config import', () => {
  it('keeps every IdentityFile as a candidate key, in file order', () => {
    const store = storeWithConfig([
      'Host two-keys',
      '    HostName 10.0.0.9',
      '    User ubuntu',
      '    IdentityFile ~/.ssh/first.pem',
      '    IdentityFile ~/.ssh/second.pem',
      '',
    ].join('\n'))
    const result = store.importFromSshConfig()
    expect(result.added).toBe(1)
    const entry = store.find('two-keys')
    expect(entry).toBeDefined()
    // The first key stays the primary; both remain available to the handshake.
    expect(entry?.auth.keyPath?.endsWith('first.pem')).toBe(true)
    expect(entry?.auth.keyPaths?.map(path => path.split(/[\\/]/).pop())).toEqual(['first.pem', 'second.pem'])
  })

  it('imports PreferredAuthentications none as none auth, not a password host', () => {
    const store = storeWithConfig([
      'Host sandbox',
      '    HostName api.example.test',
      '    Port 2222',
      '    User ibssh_token',
      '    PreferredAuthentications none',
      '',
    ].join('\n'))
    store.importFromSshConfig()
    const entry = store.find('sandbox')
    // Refusing to connect without a stored secret made this host unreachable
    // even though `ssh sandbox` works.
    expect(entry?.auth.kind).toBe('none')
  })

  it('still imports a plain public-key block as key auth', () => {
    const store = storeWithConfig([
      'Host plain',
      '    HostName 10.0.0.3',
      '    IdentityFile ~/.ssh/id_ed25519',
      '',
    ].join('\n'))
    store.importFromSshConfig()
    const entry = store.find('plain')
    expect(entry?.auth.kind).toBe('key')
    expect(entry?.auth.keyPaths).toBeUndefined()
  })

  it('repairs an already-stored host that is missing a candidate key', () => {
    const config = [
      'Host legacy',
      '    HostName 10.0.0.4',
      '    IdentityFile ~/.ssh/first.pem',
      '    IdentityFile ~/.ssh/second.pem',
      '',
    ].join('\n')
    const store = storeWithConfig(config)
    // The pre-fix shape: one key, and the import used to call this "existing".
    store.create({
      alias: 'legacy',
      host: '10.0.0.4',
      user: 'root',
      // Exactly the path the import expands `~/.ssh/first.pem` into, so the
      // stored key is recognised as already present and only the second one is
      // added.
      auth: { kind: 'key', keyPath: join(homedir(), '.ssh', 'first.pem') },
    })
    const result = store.importFromSshConfig()
    expect(result.updated).toBe(1)
    expect(result.added).toBe(0)
    expect(store.find('legacy')?.auth.keyPaths).toHaveLength(2)
  })

  it('repairs a stored password host that the config says needs no credential', () => {
    const store = storeWithConfig([
      'Host broken',
      '    HostName api.example.test',
      '    User token',
      '    PreferredAuthentications none',
      '',
    ].join('\n'))
    store.create({
      alias: 'broken',
      host: 'api.example.test',
      user: 'token',
      auth: { kind: 'password' },
    })
    const result = store.importFromSshConfig()
    expect(result.updated).toBe(1)
    expect(store.find('broken')?.auth.kind).toBe('none')
  })

  it('previews the hosts a config adds, without importing them', () => {
    const store = storeWithConfig([
      'Host already',
      '    HostName 10.0.0.6',
      '',
      'Host pending',
      '    HostName 10.0.0.7',
      '    Port 2222',
      '    User deploy',
      '    IdentityFile ~/.ssh/id_ed25519',
      '',
      'Host wild*',
      '    User root',
      '',
    ].join('\n'))
    store.create({ alias: 'already', host: '10.0.0.6', user: 'root', auth: { kind: 'agent' } })
    const preview = store.listLocalConfigHosts()
    // The stored host is not offered again; the wildcard is reported but marked
    // as not importable so the UI can leave it out of the pending list.
    expect(preview.map(host => host.alias)).toEqual(['pending', 'wild*'])
    expect(preview[0]).toMatchObject({ alias: 'pending', host: '10.0.0.7', port: 2222, user: 'deploy', auth: 'key' })
    expect(preview[1]?.skippedReason).toBe('wildcard')
    // Previewing must not mutate the store.
    expect(store.list()).toHaveLength(1)
  })

  it('leaves a host the config agrees with alone', () => {
    const store = storeWithConfig([
      'Host settled',
      '    HostName 10.0.0.5',
      '    IdentityFile ~/.ssh/only.pem',
      '',
    ].join('\n'))
    store.importFromSshConfig()
    const again = store.importFromSshConfig()
    expect(again.added).toBe(0)
    expect(again.updated).toBe(0)
    expect(again.skippedBlocks.map(block => block.reason)).toEqual(['existing'])
  })
})

describe('key candidates', () => {
  it('deduplicates and keeps insertion order', () => {
    expect(keyCandidates({ auth: { keyPath: '/a', keyPaths: ['/a', '/b', '/a'] } })).toEqual(['/a', '/b'])
  })

  it('falls back to keyPath for entries written before keyPaths existed', () => {
    expect(keyCandidates({ auth: { keyPath: '/only' } })).toEqual(['/only'])
  })

  it('returns nothing when no key is configured', () => {
    expect(keyCandidates({ auth: {} })).toEqual([])
  })
})

describe('prefersNone', () => {
  it('accepts plain and listed forms', () => {
    expect(prefersNone('none')).toBe(true)
    expect(prefersNone('publickey,none')).toBe(true)
    expect(prefersNone(' NONE ')).toBe(true)
  })

  it('is false when none is not requested', () => {
    expect(prefersNone(undefined)).toBe(false)
    expect(prefersNone('')).toBe(false)
    expect(prefersNone('publickey,password')).toBe(false)
  })
})

describe('forward discovery', () => {
  it('parses a local forward without a bind address', () => {
    expect(parseForwardSpec('local', '8080:localhost:80')).toEqual({
      kind: 'local',
      localPort: 8080,
      remoteHost: 'localhost',
      remotePort: 80,
    })
  })

  it('parses a local forward with a bind address', () => {
    expect(parseForwardSpec('local', '0.0.0.0:7863:127.0.0.1:7863')).toEqual({
      kind: 'local',
      localPort: 7863,
      bindHost: '0.0.0.0',
      remoteHost: '127.0.0.1',
      remotePort: 7863,
    })
  })

  it('parses a bracketed IPv6 bind address', () => {
    expect(parseForwardSpec('local', '[::1]:9000:host:443')).toEqual({
      kind: 'local',
      localPort: 9000,
      bindHost: '::1',
      remoteHost: 'host',
      remotePort: 443,
    })
  })

  it('parses a SOCKS forward', () => {
    expect(parseForwardSpec('dynamic', '1080')).toEqual({ kind: 'dynamic', localPort: 1080 })
    expect(parseForwardSpec('dynamic', '127.0.0.1:1080')).toEqual({
      kind: 'dynamic',
      localPort: 1080,
      bindHost: '127.0.0.1',
    })
  })

  it('rejects malformed specs instead of guessing', () => {
    expect(parseForwardSpec('local', '8080')).toBeUndefined()
    expect(parseForwardSpec('local', 'nope:localhost:80')).toBeUndefined()
    expect(parseForwardSpec('local', '8080:localhost:99999')).toBeUndefined()
    expect(parseForwardSpec('dynamic', '')).toBeUndefined()
  })

  it('extracts every forward and the destination from a real command line', () => {
    const args = splitCommandLine(
      '"C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe" -N -o BatchMode=yes -L 0.0.0.0:7863:127.0.0.1:7863 '
      + '-L 8090:172.30.0.1:8090 -D 1080 tencent',
    )
    const { destination, forwards } = parseSshArguments(args)
    expect(destination).toBe('tencent')
    expect(forwards).toHaveLength(3)
    expect(forwards.map(forward => forward.localPort)).toEqual([7863, 8090, 1080])
    expect(forwards[2]?.kind).toBe('dynamic')
  })

  it('handles the glued option form', () => {
    const { forwards } = parseSshArguments(['ssh', '-L8080:localhost:80', 'jump'])
    expect(forwards).toEqual([{ kind: 'local', localPort: 8080, remoteHost: 'localhost', remotePort: 80 }])
  })

  it('does not mistake an option value for the destination', () => {
    const args = splitCommandLine('ssh -o ConnectTimeout=10 -p 2222 -i ~/.ssh/id_ed25519 user@host')
    expect(parseSshArguments(args).destination).toBe('user@host')
  })
})
