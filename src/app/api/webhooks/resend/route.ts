import { z } from 'zod'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { readSvixHeaders, verifySvixSignature } from '@/lib/webhooks/resend-signature'

export const runtime = 'nodejs'

/**
 * POST /api/webhooks/resend — docs/05 §4.8 + docs/09 §Bounces.
 * svix-signed (HMAC-SHA256 over `${id}.${ts}.${body}`); hard bounces/complaints
 * flip an `email_failed` event matched to the original send via `message_id`.
 */

const ResendEvent = z.object({
  type: z.string(),
  data: z
    .object({
      email_id: z.string().optional(),
      to: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .passthrough(),
})

const BOUNCE_TYPES = new Set(['email.bounced', 'email.complained', 'email.failed'])

export const POST = handleRoute(async (_ctx, request: Request) => {
  const secret = env.RESEND_WEBHOOK_SECRET
  if (!features.resendWebhook || !secret) throw new AppError(ErrorCode.NOT_FOUND, 'Not found.')

  const body = await request.text()
  const verdict = verifySvixSignature({
    secret,
    headers: readSvixHeaders((name) => request.headers.get(name)),
    body,
  })
  if (!verdict.ok) {
    logger.warn('resend webhook rejected', { reason: verdict.reason })
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid webhook signature.')
  }

  const event = ResendEvent.parse(JSON.parse(body))
  if (!BOUNCE_TYPES.has(event.type)) {
    // delivered/opened etc. — accepted, no action in Phase 2 (docs/09 §Bounces scope).
    return { ok: true, ignored: event.type }
  }
  const emailId = event.data.email_id
  if (!emailId) return { ok: true, matched: false }

  const supabase = createServiceClient()
  // payload->>message_id links the bounce to our email_sent journal (docs/09 §Bounces).
  const { data: sent, error: lookupError } = await supabase
    .from('timeline_events')
    .select('owner_id, applicant_id, application_id')
    .filter('payload->>message_id', 'eq', emailId)
    .eq('type', 'email_sent')
    .order('created_at', { ascending: false })
    .limit(1)
  if (lookupError)
    throw new AppError(ErrorCode.INTERNAL, 'Webhook lookup failed.', { cause: lookupError })

  const original = (sent ?? [])[0] as
    { owner_id: string; applicant_id: string | null; application_id: string | null } | undefined
  if (!original) {
    // Not one of ours (or send predates journaling) — ack so Resend stops retrying.
    return { ok: true, matched: false }
  }

  const { error: eventError } = await supabase.from('timeline_events').insert({
    owner_id: original.owner_id,
    applicant_id: original.applicant_id,
    application_id: original.application_id,
    actor_id: null,
    type: 'email_failed',
    payload: { reason: event.type, message_id: emailId },
  })
  if (eventError)
    throw new AppError(ErrorCode.INTERNAL, 'Webhook event write failed.', { cause: eventError })

  return { ok: true, matched: true }
})
