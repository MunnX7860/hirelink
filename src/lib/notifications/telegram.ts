import 'server-only'

import type { DeliveryResult, NewApplicationEvent } from '@/lib/notifications/types'
import { env } from '@/lib/env'

/**
 * Telegram Bot API — docs/08. Send-only in Phase 1 (no webhook).
 * Template is fixed; ALL user content is MarkdownV2-escaped (docs/08 §6 tests).
 */

const API_BASE = 'https://api.telegram.org'
const TIMEOUT_MS = 8_000

/** Escape every MarkdownV2 reserved char in dynamic content (docs/08 §2). */
export function escapeMarkdownV2(input: string): string {
  return input.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`)
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** docs/08 §2 template — new applicant alert. Pure for testing. */
export function buildNewApplicationMessage(e: NewApplicationEvent): {
  text: string
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; url: string }>> }
} {
  const lines = [
    `🆕 *New applicant — ${escapeMarkdownV2(truncate(e.jobTitle, 80))}*`,
    `👤 ${escapeMarkdownV2(truncate(e.applicantName, 80))}`,
    `✉️ ${escapeMarkdownV2(e.email)}${e.phone ? `   📞 ${escapeMarkdownV2(e.phone)}` : '   📞 —'}`,
    `📄 Resume: ${e.resumeUploaded ? 'attached ✔' : 'upload failed ⚠'}`,
    `🕐 just now`,
  ]
  return {
    text: lines.join('\n'),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: 'View in dashboard',
            url: `${env.NEXT_PUBLIC_APP_URL}/dashboard/applications/${e.applicationId}`,
          },
        ],
      ],
    },
  }
}

/** docs/03 §5 resume-failure alert to the owner. Pure for testing. */
export function buildResumeFailedMessage(input: {
  jobTitle: string
  applicantName: string
}): string {
  return [
    `⚠️ *Resume upload failed* — ${escapeMarkdownV2(truncate(input.jobTitle, 80))}`,
    `Applicant ${escapeMarkdownV2(truncate(input.applicantName, 80))} applied successfully, but their resume could not be stored in Google Drive\\. Check your Drive connection in Settings\\.`,
    `They can resubmit via the same hiring link\\.`,
  ].join('\n')
}

interface TelegramSendInput {
  botToken: string
  chatId: string
  text: string
  replyMarkup?: unknown
}

/** Raw sendMessage with docs/08 §3 timeout + error mapping. Throws only on programming error; failures come back as DeliveryResult. */
export async function sendTelegramMessage(input: TelegramSendInput): Promise<DeliveryResult> {
  try {
    const res = await fetch(`${API_BASE}/bot${input.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      error_code?: number
      description?: string
      parameters?: { retry_after?: number }
    }
    if (body.ok) return { ok: true }
    const code = body.error_code ?? res.status
    // 429: honour retry_after once upstream (docs/08 §3) — retryable here.
    if (code === 429) return { ok: false, code: 'telegram_rate_limited', retryable: true }
    if (code === 401) return { ok: false, code: 'telegram_unauthorized', retryable: false }
    if (code === 403) return { ok: false, code: 'telegram_blocked', retryable: false }
    return { ok: false, code: `telegram_${code}`, retryable: code >= 500 }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, code: 'telegram_timeout', retryable: true }
    }
    return { ok: false, code: 'telegram_network', retryable: true }
  }
}

/** Validate a bot token (settings connect flow — docs/02 §8.2). */
export async function telegramGetMe(
  botToken: string,
): Promise<{ ok: boolean; botName?: string | undefined; botUsername?: string | undefined }> {
  try {
    const res = await fetch(`${API_BASE}/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json()) as {
      ok?: boolean
      result?: { first_name?: string; username?: string }
    }
    if (!body.ok) return { ok: false }
    return { ok: true, botName: body.result?.first_name, botUsername: body.result?.username }
  } catch {
    return { ok: false }
  }
}

/** Chat-ID autodetect via getUpdates (owner pressed /start in their bot — docs/02 §8.2). */
export async function telegramDetectChatId(botToken: string): Promise<string | null> {
  interface Update {
    message?: { chat?: { id?: number } }
    my_chat_member?: { chat?: { id?: number } }
  }
  try {
    const res = await fetch(`${API_BASE}/bot${botToken}/getUpdates`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.json()) as { ok?: boolean; result?: Update[] }
    if (!body.ok || !body.result) return null
    for (const update of [...body.result].reverse()) {
      const id = update.message?.chat?.id ?? update.my_chat_member?.chat?.id
      if (typeof id === 'number') return String(id)
    }
    return null
  } catch {
    return null
  }
}
