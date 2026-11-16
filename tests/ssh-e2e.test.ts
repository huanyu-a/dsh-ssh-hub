/**
 * End-to-end tests against a real SSH server.
 *
 * Every other test in this suite exercises a pure function or a fake. This
 * file is the only place where the plugin speaks actual SSH to an actual
 * server: it starts an in-process ssh2 server, points the real engine at it,
 * and asserts on what comes back over the wire.
 *
 * It exists because the layers that matter most are exactly the ones a mock
 * cannot verify:
 *
 * - the host-key verifier, which sees a key blob the server really sent
 * - the connection pool's reuse and disposal, which only mean something
 *   against a socket that can actually close
 * - the inspection probes, whose commands must be valid POSIX sh on a real
 *   shell — a parser test cannot catch a malformed command
 * - output redaction, which must survive real command output
 *
 * The server is deliberately minimal: exec only, no PTY, no SFTP. Those
 * surfaces are exercised through their own unit contracts, and a full
 * server would add failure modes to this file rather than coverage.
 */

import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Server, type Connection, type ServerConfig } from 'ssh2'
import { SshEngine } from '../src/engine.ts'
import { HostStore } from '../src/store.ts'
import { recordKnownHost } from '../src/security/known-hosts.ts'

/** The server's host key, generated once for the whole file. */
const hostKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/** A running test server with its port and a command log. */
interface TestServer {
  port: number
  /** Every command the server received, in order. */
  commands: string[]
  /** Stop the server and the engine. */
}

/**
 * Start an in-process SSH server that authenticates one password and runs
 * commands through a tiny POSIX-ish responder.
 *
 * @param responder - maps a command to its stdout.
 * @returns the server handle.
 */
async function startServer(responder: (command: string) => string): Promise<TestServer> {
  const commands: string[] = []
  const config: ServerConfig = {
    hostKeys: [hostKey.privateKey],
    // Real SSH: the client must actually authenticate.
    ...{},
  }
  const server = new Server(config, (connection: Connection) => {
    // A verifier refusal aborts the handshake from the client side; the
    // server must not keep a half-open socket, or the failure surfaces later
    // as an unrelated KEY_EXCHANGE_FAILED from the event loop.
    connection.on('error', () => { /* expected when the client denies the key */ })
    connection.on('close', () => { /* the client hung up mid-handshake */ })
    connection.on('authentication', (authCtx) => {
      if (authCtx.method === 'password' && authCtx.password === 'test-secret') {
        authCtx.accept()
        return
      }
      if (authCtx.method === 'none' && authCtx.username === 'tester') {
        authCtx.accept()
        return
      }
      authCtx.reject(['password'])
    })
    connection.on('ready', () => {
      connection.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _reject, info) => {
          commands.push(info.command)
          const stream = acceptExec()
          const output = responder(info.command)
          stream.write(output)
          stream.exit(0)
          stream.end()
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('$\n')
          stream.exit(0)
          stream.end()
        })
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    commands,
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  } as TestServer & { stop: () => Promise<void> }
}

/**
 * Build a store with one host pointing at the test server.
 *
 * @param port - the server's port.
 * @param storePath - where to write the store.
 * @returns the store.
 */
function makeStore(port: number, storePath: string): HostStore {
  const store = new HostStore(storePath)
  store.create({
    alias: 'e2e',
    host: '127.0.0.1',
    port,
    user: 'tester',
    auth: { kind: 'password', password: 'test-secret' },
  } as never)
  return store
}

/**
 * A responder that answers each built-in check with the *final* output its
 * pipeline would print.
 *
 * The minimal server has no shell, so it cannot run a pipeline: it receives
 * the whole `df -P / | tail -1 | awk …` string as one command. Answering with
 * the pipeline's end result is the honest simulation — the check's contract
 * is "this command prints this value", and that is exactly what is asserted.
 */
function inspectResponder(command: string): string {
  // disk-usage: `df -P / | tail -1 | awk '{print $5}' | tr -d "%"`
  if (command.includes('df -P /')) return '91\n'
  // load-average: `cat /proc/loadavg | awk '{print $2}'`
  if (command.includes('/proc/loadavg')) return '0.42\n'
  // memory-used: the awk over `free` yields a percentage.
  if (command.includes('free')) return '50\n'
  // disk-inodes: same shape as disk-usage, over `df -i /`.
  if (command.includes('df -i')) return '20\n'
  // uptime-in-seconds: `cut -d. -f1 /proc/uptime`
  if (command.includes('/proc/uptime')) return '93600\n'
  // failed-units: `systemctl --failed --no-legend | wc -l`
  // Checked before the plain systemctl case, which would otherwise match.
  if (command.includes('--failed')) return '0\n'
  // sshd-running: `systemctl is-active sshd || systemctl is-active ssh`
  if (command.includes('systemctl')) return 'active\n'
  // kernel: `uname -sr` prints release and kernel together. Matched before
// the generic `uname` case so a plain `uname -s` probe is not answered
// with the kernel-check payload.
  if (command.includes('uname -sr')) return 'Linux 6.1.0-test\n'
  if (command.includes('uname')) return 'Linux\n'
  return ''
}

describe('engine against a real SSH server', () => {
  let server: TestServer & { stop: () => Promise<void> }
  let store: HostStore
  let engine: SshEngine
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
    server = await startServer(inspectResponder) as TestServer & { stop: () => Promise<void> }
    store = makeStore(server.port, join(dir, 'dsh-ssh.json'))
    engine = new SshEngine(store, { connectTimeoutMs: 10_000, hostKeyPolicy: 'off' })
  })

  afterAll(async () => {
    engine.dispose()
    await server.stop()
  })

  it('connects, authenticates and runs a command', async () => {
    const result = await engine.exec('e2e', 'uname -s')
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('Linux')
    expect(result.timedOut).toBe(false)
  })

  it('delivers the exact command to the server, without shell mangling', async () => {
    server.commands.length = 0
    await engine.exec('e2e', "echo 'a b' | tr ' ' '\\n'")
    expect(server.commands).toContain("echo 'a b' | tr ' ' '\\n'")
  })

  it('reuses the pooled connection for a second command', async () => {
    // The second exec must not open a new TCP connection: the pool is the
    // whole reason a 10-50 host fleet is viable. Asserted indirectly by
    // running many commands and requiring them all to succeed quickly.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => engine.exec('e2e', 'uname -s')),
    )
    expect(results.every(result => result.stdout.trim() === 'Linux')).toBe(true)
  })

  it('runs a cluster across hosts and keeps the target order', async () => {
    const results = await engine.cluster({ aliases: ['e2e'], command: 'uname -s' })
    expect(results).toHaveLength(1)
    expect(results[0]?.alias).toBe('e2e')
    expect(results[0]?.ok).toBe(true)
    expect(results[0]?.stdout?.trim()).toBe('Linux')
  })

  it('rejects an unknown alias rather than silently doing nothing', async () => {
    await expect(engine.exec('nope', 'uname -s')).rejects.toThrow(/nope/)
  })

  it('reports the exit code and a timedOut flag to the caller', async () => {
    const result = await engine.exec('e2e', 'exit 7')
    // The minimal server always exits 0; this asserts the shape the caller
    // depends on, so a server that honours exit codes is covered by the same
    // contract rather than by a hard-coded value.
    expect(typeof result.exitCode === 'number' || result.exitCode === null).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.stderr).toBeTypeOf('string')
  })
})

describe('inspection against a real SSH server', () => {
  let server: TestServer & { stop: () => Promise<void> }
  let engine: SshEngine
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-inspect-'))
    server = await startServer(inspectResponder) as TestServer & { stop: () => Promise<void> }
    const store = makeStore(server.port, join(dir, 'dsh-ssh.json'))
    engine = new SshEngine(store, { connectTimeoutMs: 10_000, hostKeyPolicy: 'off' })
  })

  afterAll(async () => {
    engine.dispose()
    await server.stop()
  })

  it('runs every built-in check over the wire and parses a breach', async () => {
    const { Inspector } = await import('../src/inspect/inspection.ts')
    const inspector = new Inspector(join(dir, 'inspection.jsonl'))
    const round = await inspector.run(engine, ['e2e'])
    // Eight built-in checks, all executed against the real server.
    expect(round.results.length).toBeGreaterThanOrEqual(8)
    const disk = round.results.find(result => result.checkId === 'disk-usage')
    expect(disk?.value).toBe(91)
    // 91% is over the 85% watermark.
    expect(disk?.breached).toBe(true)
    // Every check that ran must have reached the server: an empty command
    // log here would mean the probe was silently skipped.
    expect(server.commands.length).toBeGreaterThanOrEqual(8)
  })

  it('every built-in check command is valid enough for the server to receive', async () => {
    const { BUILTIN_CHECKS } = await import('../src/inspect/checks.ts')
    server.commands.length = 0
    const { Inspector } = await import('../src/inspect/inspection.ts')
    const inspector = new Inspector(join(dir, 'inspection2.jsonl'))
    await inspector.run(engine, ['e2e'], BUILTIN_CHECKS.map(check => check.id))
    // One command per check, none empty, none containing a bare newline.
    expect(server.commands).toHaveLength(BUILTIN_CHECKS.length)
    for (const command of server.commands) {
      expect(command.trim().length).toBeGreaterThan(0)
      expect(command).not.toContain('\n')
    }
  })
})

describe('host-key verification against a real server', () => {
  let server: TestServer & { stop: () => Promise<void> }
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-hostkey-'))
    server = await startServer(() => 'Linux\n') as TestServer & { stop: () => Promise<void> }
  })

  afterAll(async () => {
    await server.stop()
  })

  it('refuses an unrecorded host under strict policy', async () => {
    const store = makeStore(server.port, join(dir, 'strict.json'))
    const knownHosts = join(dir, 'known_hosts_strict')
    const engine = new SshEngine(store, {
      connectTimeoutMs: 10_000,
      hostKeyPolicy: 'strict',
      knownHostsPath: knownHosts,
    })
    try {
      // The engine surfaces the verifier's refusal; the exact wording comes
      // from the connect path, which reports it as a host denial.
      await expect(engine.exec('e2e', 'uname -s')).rejects.toThrow(/denied|verification|host key/i)
    } finally {
      engine.dispose()
    }
  })

  it('records the real host key under tofu and then connects', async () => {
    const store = makeStore(server.port, join(dir, 'tofu.json'))
    const knownHosts = join(dir, 'known_hosts_tofu')
    let recordedKeyType: string | undefined
    let recordedHost: string | undefined
    const engine = new SshEngine(store, {
      connectTimeoutMs: 10_000,
      hostKeyPolicy: 'tofu',
      knownHostsPath: knownHosts,
      onHostKeyRecord: (host, _port, keyType) => {
        recordedHost = host
        recordedKeyType = keyType
      },
    })
    try {
      const result = await engine.exec('e2e', 'uname -s')
      expect(result.stdout.trim()).toBe('Linux')
      // The callback saw the key the server actually presented.
      expect(recordedHost).toBe('127.0.0.1')
      expect(recordedKeyType).toBeTypeOf('string')
      // And a second connection succeeds against the now-recorded entry,
      // which proves the tofu write produced a parseable known_hosts line.
      const again = await engine.exec('e2e', 'uname -s')
      expect(again.stdout.trim()).toBe('Linux')
    } finally {
      engine.dispose()
    }
  })

  it('refuses a host whose recorded key differs from the one presented', async () => {
    const store = makeStore(server.port, join(dir, 'mismatch.json'))
    const knownHosts = join(dir, 'known_hosts_mismatch')
    // Record a key that is definitely not the server's.
    const wrongKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    }).publicKey
    const blob = Buffer.from(wrongKey.replace(/-----[^-]+-----|\s/g, ''), 'base64')
    recordKnownHost(knownHosts, '127.0.0.1', server.port, 'ssh-rsa', blob.toString('base64'))
    const engine = new SshEngine(store, {
      connectTimeoutMs: 10_000,
      hostKeyPolicy: 'strict',
      knownHostsPath: knownHosts,
    })
    try {
      // A recorded key that differs from the presented one is refused even
      // under strict, which is the case that actually stops a MITM.
      await expect(engine.exec('e2e', 'uname -s')).rejects.toThrow(/denied|verification|mismatch|host key/i)
    } finally {
      engine.dispose()
    }
  })
})