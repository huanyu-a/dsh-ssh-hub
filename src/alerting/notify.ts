/**
 * Outbound notification: a template-driven HTTP sender.
 *
 * A generic HTTP template with named placeholders covers Bark, Telegram,
 * Lark/Feishu and WeCom without the plugin growing a dependency on each of
 * them — the operator supplies the URL and the body shape, and the plugin
 * substitutes the values.
 *
 * The template placeholders are the ones the operator actually reads:
 * `#SERVER.NAME#`, `#SERVER.ALIAS#`, `#RULE.NAME#`, `#RULE.ID#`,
 * `#VALUE#`, `#MESSAGE#`, `#STATE#`, `#TIME#`.
 *
 * An unknown placeholder is left AS IS rather than replaced with an empty
 * string: a typo in a template must be visible, not silently blank.
 */

import type { AlertNotification } from './rules.ts'

/** One notification channel. */
export interface NotifyChannel {
  /** A stable name for the channel. */
  id: string
  /** The target URL. */
  url: string
  /** The HTTP method (default POST). */
  method?: string
  /** The body template, with placeholders. */
  body?: string
  /** Extra headers. */
  headers?: Record<string, string>
  /** The content type (default application/json). */
  contentType?: string
}

/** The outcome of one delivery attempt. */
export interface NotifyOutcome {
  channelId: string
  ok: boolean
  /** The HTTP status, when a response arrived. */
  status?: number
  /** The error message, when the attempt failed. */
  error?: string
}

/**
 * The placeholders a template may use.
 *
 * @param notification - the event to describe.
 * @param extra - additional key/value pairs (a rule title, a value).
 * @returns the placeholder map.
 */
export function placeholders(
  notification: AlertNotification,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    '#SERVER.ALIAS#': notification.alias,
    '#SERVER.NAME#': extra.serverName ?? notification.alias,
    '#RULE.ID#': notification.ruleId,
    '#RULE.NAME#': extra.ruleName ?? notification.ruleId,
    '#VALUE#': notification.value,
    '#STATE#': notification.kind === 'trigger' ? '触发' : '恢复',
    '#MESSAGE#': extra.message ?? defaultMessage(notification),
    '#TIME#': new Date(notification.at).toISOString(),
    ...extra,
  }
}

/** The default message when the template does not supply one. */
function defaultMessage(notification: AlertNotification): string {
  return notification.kind === 'trigger'
    ? `${notification.alias} 的 ${notification.title} 超出阈值（当前 ${notification.value}）`
    : `${notification.alias} 的 ${notification.title} 已恢复正常（当前 ${notification.value}）`
}

/**
 * Substitute the placeholders in a template.
 *
 * @param template - the template text.
 * @param values - the placeholder values.
 * @returns the substituted text; unknown placeholders are left as they are.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/#[A-Z0-9_.]+#/g, (match) => {
    const value = values[match]
    return value === undefined ? match : value
  })
}

/**
 * The built-in channel presets.
 *
 * Each preset is a starting point, not a fixed format: the operator can
 * edit the URL and body to match their deployment.
 */
export const NOTIFY_PRESETS: ReadonlyArray<{ id: string; title: string; channel: NotifyChannel }> = [
  {
    id: 'bark',
    title: 'Bark (iOS)',
    channel: {
      id: 'bark',
      url: 'https://api.day.app/YOUR_KEY',
      method: 'GET',
      body: '',
      headers: {},
    },
  },
  {
    id: 'telegram',
    title: 'Telegram',
    channel: {
      id: 'telegram',
      url: 'https://api.telegram.org/botYOUR_TOKEN/sendMessage',
      method: 'POST',
      body: JSON.stringify({ chat_id: 'YOUR_CHAT_ID', text: '#MESSAGE#' }),
      contentType: 'application/json',
    },
  },
  {
    id: 'lark',
    title: '飞书 / Lark',
    channel: {
      id: 'lark',
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_HOOK',
      method: 'POST',
      body: JSON.stringify({ msg_type: 'text', content: { text: '#MESSAGE#' } }),
      contentType: 'application/json',
    },
  },
  {
    id: 'wecom',
    title: '企业微信 / WeCom',
    channel: {
      id: 'wecom',
      url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY',
      method: 'POST',
      body: JSON.stringify({ msgtype: 'text', text: { content: '#MESSAGE#' } }),
      contentType: 'application/json',
    },
  },
]

/**
 * Send one notification to one channel.
 *
 * The fetch is deliberately fire-and-forget from the caller's point of
 * view: a failing notification channel must not stop the inspection loop,
 * but its failure IS reported so a broken channel is visible.
 *
 * @param channel - the channel to send to.
 * @param notification - the event.
 * @param extra - extra placeholder values.
 * @returns the delivery outcome.
 */
export async function notify(
  channel: NotifyChannel,
  notification: AlertNotification,
  extra: Record<string, string> = {},
): Promise<NotifyOutcome> {
  const values = placeholders(notification, extra)
  const method = (channel.method ?? 'POST').toUpperCase()
  try {
    let url = channel.url
    const headers: Record<string, string> = { ...channel.headers }
    let body: string | undefined
    if (channel.body !== undefined && channel.body !== '') {
      body = renderTemplate(channel.body, values)
      headers['content-type'] = channel.contentType ?? 'application/json'
    } else if (method === 'GET') {
      // A GET channel carries the message in the query string.
      const separator = url.includes('?') ? '&' : '?'
      url = `${url}${separator}body=${encodeURIComponent(values['#MESSAGE#'] ?? '')}`
    }
    const response = await fetch(url, { method, headers, body })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        channelId: channel.id,
        ok: false,
        status: response.status,
        error: `notification failed with HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
      }
    }
    return { channelId: channel.id, ok: true, status: response.status }
  } catch (error) {
    return {
      channelId: channel.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Send one notification to every channel.
 *
 * @param channels - the channels.
 * @param notification - the event.
 * @param extra - extra placeholder values.
 * @returns one outcome per channel.
 */
export async function notifyAll(
  channels: NotifyChannel[],
  notification: AlertNotification,
  extra: Record<string, string> = {},
): Promise<NotifyOutcome[]> {
  const outcomes: NotifyOutcome[] = []
  for (const channel of channels) {
    outcomes.push(await notify(channel, notification, extra))
  }
  return outcomes
}
