/**
 * Agent tools for the cross-host log search.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SshEngine } from '../engine.ts'
import { renderLogSearch, searchLogs, type LogSearchResult } from './search.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** The log-search tool. */
export function hubLogSearchTool(engine: SshEngine) {
  return defineTool({
    name: 'hub_log_search',
    description: 'Search logs across many SSH hosts at once. Reads the systemd journal or log files under a directory on each host — nothing is installed on the remote side and nothing is written. Matches are bounded per host, and the result says so when it was truncated. Use this to trace a failure across the fleet; use ssh_exec for a one-off command.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'The text to search for (a fixed string, not a regular expression).' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Host aliases to search. Optional when environment or tags is given.' },
      environment: { type: 'string', description: 'Search only hosts with this environment label (exact match).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Search only hosts carrying ALL of these tags.' },
      source: { type: 'string', enum: ['journal', 'files'], description: 'Where to search: the systemd journal, or files under a directory (default journal).' },
      directory: { type: 'string', description: 'The log directory, when the source is files (default /var/log).' },
      unit: { type: 'string', description: 'Filter the journal by systemd unit, e.g. nginx.' },
      sinceSeconds: { type: 'integer', description: 'Only search journal entries newer than this many seconds ago.' },
      maxLinesPerHost: { type: 'integer', description: 'How many matching lines to keep per host (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          targets: { type: 'array', items: { type: 'string' } },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                matches: { type: 'integer', required: true },
                totalMatches: { type: 'integer' },
                lines: { type: 'array', items: { type: 'string' } },
                truncated: { type: 'boolean' },
                error: { type: 'string' },
              },
            },
            required: true,
          },
          totalLines: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: {
        ok: boolean
        targets?: string[]
        results: Array<{ alias: string; ok: boolean; matches: number; totalMatches?: number; lines?: string[]; truncated?: boolean; error?: string }>
        totalLines: number
        truncated: boolean
        durationMs: number
        error?: string
      }) => {
        if (value.error !== undefined) return text(`日志检索失败：${value.error}`)
        const summary = `跨机日志检索：${value.targets?.length ?? 0} 台主机，命中 ${value.totalLines} 行，耗时 ${value.durationMs}ms`
        const lines: string[] = [summary]
        if (value.truncated) lines.push('（部分主机输出被截断，命中数可能高于显示行数）')
        for (const result of value.results) {
          if (!result.ok) {
            lines.push('', `${result.alias}：检索失败：${result.error ?? '未知错误'}`)
            continue
          }
          if (result.matches === 0) continue
          lines.push('', `── ${result.alias}（共 ${result.totalMatches ?? result.matches} 条命中）`)
          for (const line of result.lines ?? []) lines.push(line)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const targets = resolveLogTargets(engine, args.aliases, args.environment, args.tags)
      if (targets.length === 0) {
        return {
          ok: true,
          targets: [],
          results: [],
          totalLines: 0,
          truncated: false,
          durationMs: 0,
        }
      }
      const result = await searchLogs(engine, {
        source: args.source === 'files' ? 'files' : 'journal',
        pattern: args.pattern,
        ...(args.directory !== undefined ? { directory: args.directory } : {}),
        ...(args.unit !== undefined ? { unit: args.unit } : {}),
        ...(args.sinceSeconds !== undefined ? { since: Math.floor(Date.now() / 1000) - args.sinceSeconds } : {}),
        ...(args.maxLinesPerHost !== undefined ? { maxLinesPerHost: args.maxLinesPerHost } : {}),
      }, targets)
      return {
        ok: result.ok,
        targets: result.targets,
        results: result.results.map(host => ({
          alias: host.alias,
          ok: host.ok,
          matches: host.lines.length,
          ...(host.totalMatches !== undefined ? { totalMatches: host.totalMatches } : {}),
          lines: host.lines,
          ...(host.truncated === true ? { truncated: true } : {}),
          ...(host.error !== undefined ? { error: host.error } : {}),
        })),
        totalLines: result.totalLines,
        truncated: result.truncated,
        durationMs: result.durationMs,
      }
    },
  })
}

/**
 * Resolve the hosts to search.
 *
 * @param engine - the SSH engine.
 * @param aliases - explicit aliases.
 * @param environment - an environment label.
 * @param tags - tags that must all be present.
 * @returns the selected aliases.
 */
function resolveLogTargets(
  engine: SshEngine,
  aliases?: string[],
  environment?: string,
  tags?: string[],
): string[] {
  const hasAlias = aliases !== undefined && aliases.length > 0
  const hasEnvironment = environment !== undefined && environment !== ''
  const hasTags = tags !== undefined && tags.length > 0
  if (!hasAlias && !hasEnvironment && !hasTags) {
    throw new Error('hub_log_search requires aliases, environment, or tags to limit the target set')
  }
  let hosts = engine.store.list()
  if (hasAlias) {
    const wanted = new Set(aliases as string[])
    hosts = hosts.filter(host => wanted.has(host.alias))
  }
  if (hasEnvironment) {
    hosts = hosts.filter(host => host.environment === environment)
  }
  if (hasTags) {
    const wanted = tags as string[]
    hosts = hosts.filter(host => wanted.every(tag => host.tags.includes(tag)))
  }
  return hosts.map(host => host.alias)
}
