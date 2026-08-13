import 'server-only'

import { Resend } from 'resend'
import nodemailer from 'nodemailer'
import type { DeliveryResult } from '@/lib/notifications/types'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Email transport — docs/09 §1. Precedence: Gmail SMTP → Resend → the env-gated
 * null-transport that renders + logs (`simulated: true`) so local dev works
 * without keys. Gmail wins when both are configured (explicitly chosen; it is
 * the cheaper path and the one a solo owner is likelier to have set up).
 */

/** docs/09 §5: match Resend's own timeout posture so one hung SMTP dial can't stall `after()`. */
const SMTP_TIMEOUT_MS = 15_000

/** Splits `"Name" <addr>` / `Name <addr>` / `addr` into its parts. Unquotes a quoted name. */
function parseFromAddress(emailFrom: string): { name: string; address: string } {
  const match = emailFrom.match(/^(.*)<(.+)>\s*$/)
  if (!match) return { name: '', address: emailFrom.trim() }
  const rawName = (match[1] ?? '').trim()
  const name = rawName.replace(/^"(.*)"$/, '$1')
  return { name, address: (match[2] ?? '').trim() }
}

/**
 * Builds a valid RFC 5322 From header: `"Display Name" <address>`.
 * docs/09 §1: display name is `"{Owner/Company name} via HireLink"` when `fromName`
 * is given (applicant-facing emails); the base name as-is otherwise (system alerts
 * to the owner, docs/09 §2 `owner_resume_failed`). The address is never touched —
 * only the display name changes, unlike the previous implementation which spliced
 * `fromName` inside the angle brackets and produced an invalid address.
 */
export function buildFromHeader(emailFrom: string, fromName?: string, addressOverride?: string) {
  const { name: baseName, address } = parseFromAddress(emailFrom)
  const finalAddress = addressOverride ?? address
  const displayName = fromName ? (baseName ? `${fromName} via ${baseName}` : fromName) : baseName
  if (!displayName) return finalAddress
  return `"${displayName.replace(/"/g, '\\"')}" <${finalAddress}>`
}

/**
 * Gmail SMTP send. Note the `addressOverride`: Gmail silently rewrites the From
 * address to the authenticated account (unless a verified "Send mail as" alias
 * matches), so honouring EMAIL_FROM's address here would make the header lie
 * about what recipients actually see. Only the display name is ours to set.
 */
async function sendViaGmail(input: {
  to: string
  subject: string
  html: string
  text: string
  fromName?: string
}): Promise<DeliveryResult & { messageId?: string }> {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  })
  try {
    const info = await transporter.sendMail({
      from: buildFromHeader(env.EMAIL_FROM, input.fromName, env.GMAIL_USER),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })
    return { ok: true, ...(info.messageId ? { messageId: info.messageId } : {}) }
  } catch (err) {
    // 421/45x are transient (incl. Gmail's per-day throttle); 5xx auth/policy
    // rejections are permanent and retrying just burns the daily quota.
    const code = (err as { responseCode?: number }).responseCode
    const retryable = code === undefined || code === 421 || (code >= 450 && code < 500)
    logger.error('gmail smtp send failed', {
      ...(code ? { response_code: code } : {}),
      retryable,
    })
    return { ok: false, code: `email_smtp_${code ?? 'network'}`, retryable }
  } finally {
    transporter.close()
  }
}

export async function sendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
  /** Applicant-facing brand name, rendered as "{fromName} via {base}". Omit for owner-facing system alerts. */
  fromName?: string
  template: string
}): Promise<DeliveryResult & { simulated?: boolean; messageId?: string }> {
  if (!features.email) {
    logger.info('email simulated (no GMAIL_USER/GMAIL_APP_PASSWORD or RESEND_API_KEY)', {
      template: input.template,
      to_domain: input.to.split('@')[1] ?? '?', // never log full PII address (docs/14 §4)
      subject: input.subject,
    })
    return { ok: true, simulated: true }
  }

  if (features.gmailSmtp) {
    return sendViaGmail({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.fromName ? { fromName: input.fromName } : {}),
    })
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY)
    const from = buildFromHeader(env.EMAIL_FROM, input.fromName)
    // Note: Resend SDK handles its own request timeouts; AbortSignal isn't
    // part of CreateEmailRequestOptions in this SDK version.
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })
    if (error) {
      // Resend returns 4xx/5xx as structured errors; rate limit is retryable once (docs/09 §5).
      const statusCode = (error as { statusCode?: number }).statusCode ?? 0
      const retryable = statusCode === 429 || statusCode >= 500
      return { ok: false, code: `email_${statusCode || 'error'}`, retryable }
    }
    // Journaled on email_sent so the bounce webhook can match by id (docs/09 §Bounces).
    return { ok: true, ...(data?.id ? { messageId: data.id } : {}) }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, code: 'email_timeout', retryable: true }
    }
    return { ok: false, code: 'email_network', retryable: true }
  }
}
