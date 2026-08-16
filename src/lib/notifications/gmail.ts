import 'server-only'

// Subpath import for the same reason as Drive (docs/12 §8): the googleapis index
// pulls ~200 API surfaces and blows past the sandbox's RAM during typecheck.
import { gmail } from 'googleapis/build/src/apis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import type { DeliveryResult } from '@/lib/notifications/types'
import { logger } from '@/lib/logger'

/**
 * Gmail API transport — sends as a recruiter who connected their own mailbox
 * (scope `gmail.send`, docs/09 §1). Distinct from the GMAIL_USER/GMAIL_APP_PASSWORD
 * SMTP path, which is one platform-wide account; this one is per-workspace and
 * carries no shared secret — the recruiter grants a revocable token instead.
 */

const GMAIL_TIMEOUT_MS = 15_000

/**
 * Strips CR/LF from a header value. Unlike the Resend/nodemailer paths, this
 * transport assembles raw RFC 5322 itself, so a newline inside an org-supplied
 * display name or job title would inject arbitrary headers. Applied to every
 * interpolated header below.
 */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 encoded-word — display names may hold non-ASCII (docs/09 §3 i18n). */
function encodeHeaderWord(value: string): string {
  // Printable ASCII passes through untouched; anything else becomes a base64
  // encoded-word so accented names and non-Latin scripts don't arrive mangled.
  // A codepoint check rather than a regex, to keep the intent obvious.
  const isPrintableAscii = [...value].every((ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return cp >= 0x20 && cp <= 0x7e
  })
  return isPrintableAscii ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Builds the RFC 5322 message. Multipart/alternative so clients that refuse HTML
 * still get the plaintext leg — the same guarantee the Resend path gives.
 */
function buildRawMessage(input: {
  from: string
  to: string
  subject: string
  html: string
  text: string
}): string {
  // Fixed rather than random: Math.random/Date are avoided project-wide for
  // determinism, and a boundary only has to be absent from the body.
  const boundary = '----hirelink-boundary-9f41c2'
  return [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${encodeHeaderWord(sanitizeHeader(input.subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.text, 'utf8').toString('base64'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.html, 'utf8').toString('base64'),
    '',
    `--${boundary}--`,
  ].join('\r\n')
}

export async function sendViaGmailApi(input: {
  oauth2: OAuth2Client
  from: string
  to: string
  subject: string
  html: string
  text: string
}): Promise<DeliveryResult & { messageId?: string }> {
  try {
    const client = gmail({ version: 'v1', auth: input.oauth2 })
    const raw = Buffer.from(
      buildRawMessage({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      'utf8',
    )
      // base64url — the Gmail API rejects standard base64 padding/alphabet here.
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const res = await client.users.messages.send(
      { userId: 'me', requestBody: { raw } },
      { timeout: GMAIL_TIMEOUT_MS },
    )
    const id = res.data.id
    return { ok: true, ...(id ? { messageId: id } : {}) }
  } catch (err) {
    const anyErr = err as { code?: number | string; message?: string }
    const status = Number(anyErr?.code)
    const message = anyErr?.message ?? ''

    // A revoked grant is permanent and the owner must reconnect — surfaced via
    // integrationBroken so the caller flips the row to 'error' (docs/02 §8.1).
    if (message.includes('invalid_grant') || status === 401) {
      return { ok: false, code: 'gmail_unauthorized', retryable: false, integrationBroken: true }
    }
    // 403 here is usually the per-day send cap, which clears on its own.
    const retryable = status === 429 || status === 403 || status >= 500 || Number.isNaN(status)
    logger.error('gmail api send failed', {
      ...(status ? { status } : {}),
      retryable,
    })
    return { ok: false, code: `gmail_${status || 'network'}`, retryable }
  }
}

/** Exported for unit tests — header assembly is the injection-sensitive part. */
export const __testables = { buildRawMessage, encodeHeaderWord, sanitizeHeader }
