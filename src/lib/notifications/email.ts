import 'server-only'

import { Resend } from 'resend'
import type { DeliveryResult } from '@/lib/notifications/types'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Email transport — docs/09 §1. Resend when configured; otherwise the env-gated
 * null-transport that renders + logs (`simulated: true`) so local dev works without keys.
 */

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
export function buildFromHeader(emailFrom: string, fromName?: string): string {
  const { name: baseName, address } = parseFromAddress(emailFrom)
  const displayName = fromName ? (baseName ? `${fromName} via ${baseName}` : fromName) : baseName
  if (!displayName) return address
  return `"${displayName.replace(/"/g, '\\"')}" <${address}>`
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
    logger.info('email simulated (no RESEND_API_KEY)', {
      template: input.template,
      to_domain: input.to.split('@')[1] ?? '?', // never log full PII address (docs/14 §4)
      subject: input.subject,
    })
    return { ok: true, simulated: true }
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
