import 'server-only'

import { Resend } from 'resend'
import type { DeliveryResult } from '@/lib/notifications/types'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Email transport — docs/09 §1. Resend when configured; otherwise the env-gated
 * null-transport that renders + logs (`simulated: true`) so local dev works without keys.
 */

export async function sendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
  fromName: string
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
    const from = env.EMAIL_FROM.replace('<', `<${input.fromName} via `)
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
