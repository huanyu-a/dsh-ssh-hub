/**
 * Discovery of port forwards that already exist on this machine.
 *
 * The plugin can only list the tunnels it created itself, because they live in
 * process memory. An operator's real fleet usually also has forwards started by
 * hand (`ssh -N -L 8080:localhost:80 host`) or by another tool, and those were
 * invisible in the tunnels tab even while they were serving traffic. This
 * module reads the OS process table, parses the ssh forward options, and probes
 * each local port so the panel can report what is actually listening.
 *
 * Everything here is best-effort: any failure (no process tool, a denied
 * command, an unexpected line shape) yields "no external forwards" instead of
 * an error, because a diagnostic aid must never break the tab it decorates.
 */

import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import type { TunnelInfo } from '../protocol.ts'

/** How long a process scan is reused. The tab polls every 5s; spawning a
 * process enumeration that often is wasteful and briefly spikes CPU. */
const SCAN_TTL_MS = 6000

/** Hard ceiling for the process enumeration command. */
const SCAN_TIMEOUT_MS = 4000

/** How long a TCP probe may take before the port counts as not listening. */
const PROBE_TIMEOUT_MS = 250

/** One forward extracted from an ssh command line. */
export interface ParsedForward {
  kind: 'local' | 'remote' | 'dynamic'
  /** The port that listens on THIS machine (the local side of -L and -D). */
  localPort: number
  /** Bind address for the local listener, when given. */
  bindHost?: string
  remoteHost?: string
  remotePort?: number
}

/** One ssh process and the forwards its command line declares. */
export interface ScannedProcess {
  pid: number
  /** Destination alias/host: the last bare argument (OpenSSH's destination). */
  destination: string
  forwards: ParsedForward[]
}

/** Cached scan so the 5s poll does not fork a process every tick. */
let scanCache: { at: number; value: ScannedProcess[] } | undefined

/**
 * Split an ssh command line into arguments, tolerating both quoting styles a
 * Windows process table can contain.
 * @param commandLine - the raw command line.
 * @returns the argument list (options keep their leading dash).
 */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (const char of commandLine) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      if (started || current !== '') {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') args.push(current)
  return args
}

/**
 * Parse one `-L` / `-R` / `-D` specification.
 *
 * `-L` accepts `[bind_address:]port:host:hostport`; the bind part may itself be
 * an IPv6 literal in brackets. `-D` accepts `[bind_address:]port`. `-R` mirrors
 * `-L` but listens on the remote side, so it never owns a local port.
 * @param kind - which option produced the spec.
 * @param spec - the raw value after the option.
 * @returns the parsed forward, or undefined when the spec is not understood.
 */
export function parseForwardSpec(kind: 'local' | 'remote' | 'dynamic', spec: string): ParsedForward | undefined {
  const text = spec.trim()
  if (text === '') return undefined
  // A bracketed IPv6 bind address keeps its colons: pull it out first.
  let bindHost: string | undefined
  let rest = text
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close > 0) {
      bindHost = rest.slice(1, close)
      rest = rest.slice(close + 1).replace(/^:/, '')
    }
  }
  const parts = rest.split(':')
  const numeric = (value: string | undefined): number | undefined => {
    if (value === undefined || !/^\d+$/.test(value)) return undefined
    const parsed = Number.parseInt(value, 10)
    return parsed >= 1 && parsed <= 65535 ? parsed : undefined
  }
  if (kind === 'dynamic') {
    // [bind:]port
    const localPort = numeric(parts[parts.length - 1])
    if (localPort === undefined) return undefined
    if (bindHost === undefined && parts.length === 2) bindHost = parts[0]
    return { kind, localPort, ...(bindHost !== undefined && bindHost !== '' ? { bindHost } : {}) }
  }
  // [bind:]port:host:hostport — bind is optional, so 3 or 4 segments remain
  // after the bracketed case has been peeled off.
  if (parts.length < 3) return undefined
  const [localPortRaw, hostRaw, remotePortRaw] = parts.length === 4
    ? [parts[1], parts[2], parts[3]]
    : [parts[0], parts[1], parts[2]]
  if (parts.length === 4 && bindHost === undefined) bindHost = parts[0]
  const localPort = numeric(localPortRaw)
  const remotePort = numeric(remotePortRaw)
  if (localPort === undefined || remotePort === undefined || hostRaw === '') return undefined
  return {
    kind,
    localPort,
    remoteHost: hostRaw,
    remotePort,
    ...(bindHost !== undefined && bindHost !== '' ? { bindHost } : {}),
  }
}

/**
 * Extract the forward options and the destination from an ssh argument list.
 * @param args - argv of one ssh invocation (program name included).
 * @returns destination and forwards.
 */
export function parseSshArguments(args: string[]): { destination: string; forwards: ParsedForward[] } {
  const forwards: ParsedForward[] = []
  let destination = ''
  const takesValue = new Set(['-o', '-i', '-p', '-l', '-F', '-e', '-b', '-c', '-m', '-w', '-E', '-J', '-S', '-W'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    const next = args[index + 1]
    // The option may be glued to its value (`-L8080:host:80`) or separate.
    const attached = (flag: string): string | undefined =>
      arg.length > flag.length ? arg.slice(flag.length) : undefined
    if (arg === '-L' || arg === '-R' || arg === '-D') {
      if (next === undefined) continue
      const kind = arg === '-L' ? 'local' : arg === '-R' ? 'remote' : 'dynamic'
      const parsed = parseForwardSpec(kind, next)
      if (parsed !== undefined) forwards.push(parsed)
      index += 1
      continue
    }
    if (arg.startsWith('-L') || arg.startsWith('-R') || arg.startsWith('-D')) {
      const flag = arg.slice(0, 2)
      const value = attached(flag)
      if (value !== undefined && value !== '') {
        const kind = flag === '-L' ? 'local' : flag === '-R' ? 'remote' : 'dynamic'
        const parsed = parseForwardSpec(kind, value)
        if (parsed !== undefined) forwards.push(parsed)
      }
      continue
    }
    if (takesValue.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    // OpenSSH: the destination is the last non-option argument.
    destination = arg
  }
  return { destination, forwards }
}

/** Run a command and resolve its stdout, or '' when it fails. */
function run(command: string, args: string[], timeout = SCAN_TIMEOUT_MS): Promise<string> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        resolve(error === null ? stdout : '')
      })
    } catch {
      resolve('')
    }
  })
}

/** Enumerate ssh processes with a forward on this machine (cached). */
export async function scanSshProcesses(): Promise<ScannedProcess[]> {
  const now = Date.now()
  if (scanCache !== undefined && now - scanCache.at < SCAN_TTL_MS) return scanCache.value
  let value: ScannedProcess[] = []
  if (process.platform === 'win32') {
    // CommandLine is only populated for processes the caller can see; a denied
    // read yields '' and simply contributes no forwards.
    const stdout = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | ForEach-Object { [string]$_.ProcessId + ' ' + [string]$_.CommandLine }",
    ])
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      const match = /^(\d+)\s+(.*)$/.exec(trimmed)
      if (match === null) continue
      const pid = Number.parseInt(match[1] as string, 10)
      const args = splitCommandLine(match[2] as string)
      const { destination, forwards } = parseSshArguments(args)
      if (forwards.length > 0) value.push({ pid, destination, forwards })
    }
  } else {
    const stdout = await run('ps', ['-eo', 'pid=,args='])
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line)
      if (match === null) continue
      const args = splitCommandLine(match[2] as string)
      if (!/\bssh\b/.test(args[0] ?? '')) continue
      const { destination, forwards } = parseSshArguments(args)
      if (forwards.length > 0) value.push({ pid: Number.parseInt(match[1] as string, 10), destination, forwards })
    }
  }
  scanCache = { at: now, value }
  return value
}

/** Whether a TCP port accepts a connection right now on loopback. */
function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (result: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => { done(true) })
    socket.once('timeout', () => { done(false) })
    socket.once('error', () => { done(false) })
  })
}

/** Clear the process-scan cache (tests). */
export function resetTunnelScanCache(): void {
  scanCache = undefined
}

/**
 * Port forwards that exist on this machine but are not owned by this plugin.
 *
 * A forward whose local port is dead is still reported (`live: false`) — it was
 * declared by a running process, and hiding it would make a half-broken tunnel
 * look absent rather than broken.
 * @param owned - local ports the plugin already reports, to avoid duplicates.
 * @returns external forwards in process order.
 */
export async function discoverExternalTunnels(owned: TunnelInfo[]): Promise<TunnelInfo[]> {
  let scanned: ScannedProcess[]
  try {
    scanned = await scanSshProcesses()
  } catch {
    return []
  }
  const ownedPorts = new Set(owned.map(tunnel => tunnel.localPort))
  const found: TunnelInfo[] = []
  for (const process of scanned) {
    for (const [index, forward] of process.forwards.entries()) {
      if (forward.kind === 'remote') continue
      if (ownedPorts.has(forward.localPort)) continue
      found.push({
        id: `ext-${String(process.pid)}-${String(index)}`,
        alias: process.destination !== '' ? process.destination : `pid ${String(process.pid)}`,
        localPort: forward.localPort,
        remoteHost: forward.remoteHost ?? (forward.kind === 'dynamic' ? 'SOCKS' : ''),
        remotePort: forward.remotePort ?? 0,
        state: 'forwarding',
        startedAt: 0,
        source: 'external',
        pid: process.pid,
        kind: forward.kind,
      })
    }
  }
  await Promise.all(found.map(async tunnel => {
    tunnel.live = await probePort(tunnel.localPort)
  }))
  return found
}
