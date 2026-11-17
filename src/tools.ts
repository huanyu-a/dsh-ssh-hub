/**
 * Agent tools: the DSH-native counterpart of ssh-skill's CLI. Every tool
 * talks to the same engine the web UI uses, so a host configured in the GUI
 * is immediately operable by any agent, and vice versa.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from './engine.ts'
import type { ClusterResult, ExecResult, SshAuthKind, SshHostSummary, TunnelInfo } from './protocol.ts'
import { redactCommand, redactOutput } from './security/redact.ts'
import { discoverExternalTunnels } from './engine/tunnel-discovery.ts'
import { readTunnelRemarks, setTunnelRemark } from './engine/tunnel-remarks.ts'
import type { AuditRecorder } from './audit/recorder.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * One host row for the agent surface. The ProxyCommand STRING is deliberately
 * projected to a boolean: the command may embed credentials for a bastion
 * client, and the model only needs to know that the host goes through one.
 */
export interface AgentHostRow {
  alias: string
  host: string
  port: number
  user: string
  auth: SshAuthKind
  keyReady: boolean
  proxyJump: string[]
  proxyCommandConfigured: boolean
  forwardAgent: boolean
  description?: string
  environment?: string
  tags: string[]
  location?: string
  createdAt: number
  updatedAt: number
}

/** Project one summary onto the agent-facing row shape. */
export function toAgentHostRow(host: SshHostSummary): AgentHostRow {
  const { proxyCommand, ...rest } = host
  return { ...rest, proxyCommandConfigured: proxyCommand !== undefined }
}

/** Host table render shared by list surfaces. */
function renderHosts(hosts: AgentHostRow[]): string {
  if (hosts.length === 0) return 'no hosts configured'
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    host.user,
    host.auth,
    host.proxyJump.length > 0 ? 'jump:' + host.proxyJump.join(',') : host.proxyCommandConfigured ? 'proxy-command' : '-',
    // Forwarding is a security-relevant opt-in (the remote can sign with this
    // machine's agent), so the model must see it in the table, not only in JSON.
    host.forwardAgent ? 'yes' : '-',
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | proxy | forward | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: ExecResult): string {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Render cluster outcomes compactly. */
function renderCluster(results: ClusterResult[]): string {
  if (results.length === 0) return 'no hosts matched'
  return results.map(result => {
    const status = result.ok ? 'ok' : result.timedOut === true ? 'timed out' : 'failed'
    const tail = result.error !== undefined ? ' (' + result.error + ')' : ''
    return `${result.alias}: ${status} [exit code: ${result.exitCode ?? 'null'}]${tail}`
  }).join('\n')
}

/** One tunnel line. */
function renderTunnel(tunnel: TunnelInfo): string {
  // An external forward is not ours to stop, and its liveness is a fact worth
  // stating: "forwarding" alone would hide a declared-but-dead listener.
  const owner = tunnel.source === 'external'
    ? ` [external pid ${String(tunnel.pid ?? 0)}${tunnel.live === true ? ', port accepting' : ', port NOT listening'}]`
    : ' [plugin]'
  const meta = [tunnel.name, tunnel.description].filter(Boolean).join(' - ')
  const extra = meta ? ` [${meta}]` : ''
  return `${tunnel.id} ${tunnel.alias} 127.0.0.1:${tunnel.localPort} -> ${tunnel.remoteHost}:${tunnel.remotePort} [${tunnel.state}]${owner}${extra}`
}

/** The host-list tool. */
export function sshListTool(engine: SshEngine) {
  return defineTool({
    name: 'ssh_list',
    description: 'List configured SSH hosts (alias, host, user, auth, agent forwarding, environment, tags, description). Use ssh_exec etc. with the alias.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password', 'agent', 'none'], required: true },
                keyReady: { type: 'boolean', required: true },
                proxyJump: { type: 'array', items: { type: 'string' }, required: true },
                proxyCommandConfigured: { type: 'boolean', required: true },
                forwardAgent: { type: 'boolean', required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { hosts?: AgentHostRow[] }) => text(renderHosts(value.hosts ?? [])),
    },
    // Reads the local host registry only: safe to overlap with sibling calls.
    isConcurrencySafe: () => true,
    async execute(args) {
      return { hosts: engine.list(args.query).map(toAgentHostRow) }
    },
  })
}

/** The command-execution tool. */
export function sshExecTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'ssh_exec',
    description: 'Execute a shell command on a REMOTE SSH host by alias; the command runs on the remote host, never on this machine. For commands on this machine, use the local bash tool. Prefer combining independent read-only queries into one command.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      command: { type: 'string', required: true, description: 'The shell command to run remotely.' },
      timeoutMs: { type: 'integer', description: 'Remote command execution timeout in milliseconds (default 60000); it starts after the connection is ready. The connection and authentication ceiling is the dsh-ssh connectTimeoutMs setting, not this argument.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecResult) => text(renderExec(value)),
    },
    async execute(args, exec) {
      try {
        // Forward the caller's cancellation: aborting closes the remote channel
        // instead of leaving the command running on the host.
        const result = await engine.exec(args.alias, args.command, args.timeoutMs, exec.signal)
        audit?.record('exec', {
          ok: result.success,
          targets: [args.alias],
          summary: `exec on ${args.alias}: ${redactCommand(args.command)}`,
          detail: { exitCode: result.exitCode, durationMs: result.durationMs },
        })
        return redactExecResult(result)
      } catch (error) {
        audit?.record('exec', {
          ok: false,
          targets: [args.alias],
          summary: `exec on ${args.alias} failed: ${redactCommand(args.command)}`,
        })
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/**
 * Redact an exec result before it leaves the tool.
 *
 * The output becomes model context and, in DSH, part of the session log —
 * so a secret printed by `env` would be written into a transcript that
 * outlives the session. The redaction is a safety net, not a guarantee:
 * the remote host may hold secrets in shapes this does not recognise.
 *
 * @param result - the raw exec result.
 * @returns the redacted result.
 */
export function redactExecResult(result: ExecResult): ExecResult {
  return {
    ...result,
    stdout: redactOutput(result.stdout),
    stderr: redactOutput(result.stderr),
  }
}

/** The upload tool. */
export function sshUploadTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'ssh_upload',
    description: 'Transfer a file FROM this machine (the dsh host) TO a remote SSH host. Use this only when the file must be copied to the remote host. Files that stay on this machine are handled with the local file tools (read / write / edit), not ssh_upload.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      localPath: { type: 'string', required: true, description: 'Absolute path of the source file on THIS machine (the dsh host) — not a path on the remote host.' },
      remotePath: { type: 'string', required: true, description: 'Absolute destination path on the remote SSH host (parent dirs are created).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; transferredBytes?: number; files?: number; error?: string }) => text(value.ok
        ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, false)
        audit?.record('upload', {
          ok: true,
          targets: [args.alias],
          summary: `upload to ${args.alias}: ${args.remotePath}`,
          detail: { bytes: outcome.bytes, files: outcome.files },
        })
        return { ok: true, transferredBytes: outcome.bytes, files: outcome.files }
      } catch (error) {
        audit?.record('upload', {
          ok: false,
          targets: [args.alias],
          summary: `upload to ${args.alias} failed: ${args.remotePath}`,
        })
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The download tool. */
export function sshDownloadTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'ssh_download',
    description: 'Copy a remote FILE from a configured SSH host to this machine (the dsh host). Use this only when the source is on the remote host; files already on this machine are read with the local file tools (read / write / edit), not ssh_download. Directory download is not supported — download files individually.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Host alias from ssh_list.' },
      remotePath: { type: 'string', required: true, description: 'Absolute path of the source file on the remote SSH host.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on THIS machine (the dsh host).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; bytes?: number; error?: string }) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const outcome = await engine.download(args.alias, args.remotePath, args.localPath)
        audit?.record('download', {
          ok: true,
          targets: [args.alias],
          summary: `download from ${args.alias}: ${args.remotePath}`,
          detail: { bytes: outcome.bytes },
        })
        return { ok: true, bytes: outcome.bytes }
      } catch (error) {
        audit?.record('download', {
          ok: false,
          targets: [args.alias],
          summary: `download from ${args.alias} failed: ${args.remotePath}`,
        })
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The tunnel tool. */
export function sshTunnelTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'ssh_tunnel',
    description: 'Manage local port-forward tunnels to a configured SSH host. Start a tunnel to reach a remote internal service (database, web UI, API) through 127.0.0.1 on this machine.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'stop', 'stop-all', 'update', 'remark'], description: 'start / list / stop / stop-all / update (edit a plugin-owned tunnel) / remark (annotate a tunnel another process owns).' },
      alias: { type: 'string', description: 'Host alias (required for start, optional for stop-all).' },
      remotePort: { type: 'integer', description: 'Port on the remote side (required for start; optional new value for update).' },
      remoteHost: { type: 'string', description: 'Remote host to forward to (default 127.0.0.1 — the server itself; optional new value for update).' },
      localPort: { type: 'integer', description: 'Local listening port (default: auto-assigned; the identity of the forward for remark).' },
      name: { type: 'string', description: 'Optional project or service name for this tunnel (e.g. redis, api). An empty string clears it for update/remark.' },
      description: { type: 'string', description: 'Optional remark or purpose for this tunnel. An empty string clears it for update/remark.' },
      tunnelId: { type: 'string', description: 'Tunnel id (required for stop).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tunnel: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              alias: { type: 'string', required: true },
              localPort: { type: 'integer', required: true },
              remoteHost: { type: 'string', required: true },
              remotePort: { type: 'integer', required: true },
              state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
              error: { type: 'string' },
              startedAt: { type: 'integer', required: true },
              name: { type: 'string' },
              description: { type: 'string' },
            },
          },
          tunnels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                localPort: { type: 'integer', required: true },
                remoteHost: { type: 'string', required: true },
                remotePort: { type: 'integer', required: true },
                state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
                error: { type: 'string' },
                startedAt: { type: 'integer', required: true },
                source: { type: 'string', enum: ['plugin', 'external'] },
                pid: { type: 'integer' },
                live: { type: 'boolean' },
                kind: { type: 'string', enum: ['local', 'remote', 'dynamic'] },
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          stopped: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; tunnel?: TunnelInfo; tunnels?: TunnelInfo[]; stopped?: number; error?: string }) => {
        if (value.error !== undefined) return text(`tunnel error: ${value.error}`)
        if (value.tunnel !== undefined) {
          if (value.tunnel.state === 'failed') return text(`tunnel failed: ${value.tunnel.error ?? 'unknown error'}`)
          return text(`tunnel started: ${renderTunnel(value.tunnel)}`)
        }
        if (value.tunnels !== undefined) return text(value.tunnels.length === 0 ? 'no active tunnels' : value.tunnels.map(renderTunnel).join('\n'))
        return text(`stopped ${value.stopped ?? 0} tunnel(s)`)
      },
    },
    async execute(args) {
      if (args.action === 'list') {
        const managed = engine.listTunnels()
        // The same answer the panel gives: a forward started outside this
        // plugin is still a forward, and reporting "no active tunnels" while
        // one serves traffic sends the reader looking in the wrong place.
        const external = await discoverExternalTunnels(managed, readTunnelRemarks())
        return { ok: true, tunnels: [...managed, ...external] }
      }
      if (args.action === 'start') {
        if (args.alias === undefined || args.remotePort === undefined) {
          throw new Error('alias and remotePort are required for start')
        }
        try {
          const tunnel = await engine.startTunnel(args.alias, {
            remotePort: args.remotePort,
            remoteHost: args.remoteHost,
            localPort: args.localPort,
            name: args.name,
            description: args.description,
          })
          audit?.record('tunnel.start', {
            ok: true,
            targets: [args.alias],
            summary: `tunnel to ${args.alias}:${args.remotePort}`,
            detail: { localPort: tunnel.localPort },
          })
          return { ok: true, tunnel }
        } catch (error) {
          audit?.record('tunnel.start', {
            ok: false,
            targets: [args.alias],
            summary: `tunnel to ${args.alias}:${args.remotePort} failed`,
          })
          return { ok: false, tunnel: { id: '', alias: args.alias, localPort: 0, remoteHost: args.remoteHost ?? '127.0.0.1', remotePort: args.remotePort, state: 'failed' as const, error: error instanceof Error ? error.message : String(error), startedAt: Date.now() } }
        }
      }
      if (args.action === 'stop') {
        if (args.tunnelId === undefined) throw new Error('tunnelId is required for stop')
        const stopped = engine.stopTunnel(args.tunnelId)
        return stopped
          ? { ok: true, stopped: 1 }
          : { ok: false, stopped: 0, error: `tunnel '${args.tunnelId}' not found` }
      }
      if (args.action === 'update') {
        if (args.tunnelId === undefined) throw new Error('tunnelId is required for update')
        try {
          const result = await engine.updateTunnel(args.tunnelId, {
            name: args.name,
            description: args.description,
            remoteHost: args.remoteHost,
            remotePort: args.remotePort,
            localPort: args.localPort,
          })
          audit?.record('tunnel.update', {
            ok: true,
            targets: [result.tunnel.alias],
            summary: `tunnel ${args.tunnelId} updated${result.restarted ? ' (rebuilt)' : ''}`,
            detail: { localPort: result.tunnel.localPort, restarted: result.restarted },
          })
          return { ok: true, tunnel: result.tunnel }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (args.action === 'remark') {
        if (args.localPort === undefined) throw new Error('localPort is required for remark')
        try {
          // Two empty fields delete the entry, which is how forwards.conf
          // becomes visible again — the tool reports success either way.
          setTunnelRemark(args.localPort, { name: args.name, description: args.description })
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      if (args.action === 'stop-all') {
        const stopped = engine.stopAllTunnels(args.alias)
        return { ok: true, stopped }
      }
      throw new Error(`unknown action '${String(args.action)}'`)
    },
  })
}

/** The cluster tool. */
export function sshClusterTool(engine: SshEngine, audit?: AuditRecorder) {
  return defineTool({
    name: 'ssh_cluster',
    description: 'Run one command concurrently across selected SSH hosts; at least one aliases, environment, or tags filter is required.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to run on every matched host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Optional alias filter; at least one of aliases, environment, or tags is required.' },
      environment: { type: 'string', description: 'Optional environment filter; at least one selector is required.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional ALL-tags filter; at least one selector is required.' },
      timeoutMs: { type: 'integer', description: 'Per-host command execution timeout in milliseconds (default 60000); it does not extend the connection and authentication ceiling (the dsh-ssh connectTimeoutMs setting).' },
      maxWorkers: { type: 'integer', description: 'Concurrency cap (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { results?: ClusterResult[] }) => text(renderCluster(value.results ?? [])),
    },
    async execute(args, exec) {
      const hasSelector = (Array.isArray(args.aliases) && args.aliases.some((alias) => typeof alias === 'string' && alias.trim() !== '')) ||
        (typeof args.environment === 'string' && args.environment.trim() !== '') ||
        (Array.isArray(args.tags) && args.tags.some((tag) => typeof tag === 'string' && tag.trim() !== ''))
      if (!hasSelector) throw new Error('ssh_cluster requires aliases, environment, or tags to limit the target set')
      // Cancellation reaches every host's in-flight command.
      const results = await engine.cluster({ ...args, signal: exec.signal })
      const failed = results.filter(result => !result.ok).map(result => result.alias)
      audit?.record('cluster', {
        ok: failed.length === 0,
        targets: results.map(result => result.alias),
        summary: `cluster exec on ${results.length} host(s): ${redactCommand(args.command)}`,
        detail: { failedHosts: failed },
      })
      // Redact every host's output: the cluster result is one blob of
      // output from N hosts, so a single secret in one of them would land
      // in the session log.
      return {
        results: results.map(result => ({
          ...result,
          ...(result.stdout !== undefined ? { stdout: redactOutput(result.stdout) } : {}),
          ...(result.stderr !== undefined ? { stderr: redactOutput(result.stderr) } : {}),
        })),
      }
    },
  })
}
