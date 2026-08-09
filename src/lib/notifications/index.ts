import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { renderEmail, emailFrom } from '@/emails/registry'
import { sendEmail } from '@/lib/notifications/email'
import {
  buildNewApplicationMessage,
  buildResumeFailedMessage,
  sendTelegramMessage,
} from '@/lib/notifications/telegram'
import { resolveTelegram } from '@/lib/integrations/resolve'
import type {
  ApplicantConfirmation,
  NewApplicationEvent,
  ResumeFailedAlert,
} from '@/lib/notifications/types'

/**
 * NotificationService — docs/03 §4/§5/§6, docs/08 §4, docs/09 §5.
 * Policy: one retry after 5s, then a `*_failed` timeline event. Never throws;
 * never blocks the caller's response. Runs inside the route handler's `after()`
 * (docs/03 §5 — fire-and-forget, kept alive by the platform).
 */

const RETRY_DELAY_MS = 5_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- works with user-scoped AND service client (caller chooses, docs/03 §Rules)
type Client = SupabaseClient<any>

// Implements the docs/03 §4 NotificationService contract with D4 absorption built in:
// methods never throw and journal outcomes to timeline_events themselves, which is why
// they return void rather than the provider-level DeliveryResult (see lib/notifications/email.ts,
// lib/notifications/telegram.ts for those unions).
export class Notifications {
  /**
   * @param opts.orgId Phase 4 (docs/11 §3): when the event belongs to an org-owned
   *   entity, org integrations take precedence (org Telegram channel / Drive).
   */
  constructor(
    private readonly client: Client,
    private readonly ownerId: string,
    private readonly opts: { orgId?: string | null } = {},
  ) {}

  private async writeEvent(
    type: string,
    payload: Record<string, unknown>,
    ids: { applicantId?: string; applicationId?: string },
  ) {
    await this.client.from('timeline_events').insert({
      owner_id: this.ownerId,
      applicant_id: ids.applicantId ?? null,
      application_id: ids.applicationId ?? null,
      actor_id: null, // system
      type,
      payload,
    })
  }

  private async telegram(
    text: string,
    replyMarkup?: unknown,
  ): Promise<{ ok: boolean; code?: string }> {
    const creds = await resolveTelegram(this.client, {
      ownerId: this.ownerId,
      orgId: this.opts.orgId ?? null,
    })
    if (!creds) return { ok: false, code: 'telegram_not_configured' }
    const first = await sendTelegramMessage({
      botToken: creds.botToken,
      chatId: creds.chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    })
    if (first.ok) return { ok: true }
    if (!first.retryable) return { ok: false, code: first.code }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    const second = await sendTelegramMessage({
      botToken: creds.botToken,
      chatId: creds.chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    })
    return second.ok ? { ok: true } : { ok: false, code: second.code }
  }

  async notifyOwnerNewApplication(e: NewApplicationEvent): Promise<void> {
    try {
      const { text, replyMarkup } = buildNewApplicationMessage(e)
      const result = await this.telegram(text, replyMarkup)
      await this.writeEvent(
        result.ok ? 'telegram_sent' : 'telegram_failed',
        { to: 'owner' },
        {
          applicationId: e.applicationId,
          ...(e.applicantId ? { applicantId: e.applicantId } : {}),
        },
      )
    } catch (err) {
      logger.error('notifyOwnerNewApplication failed', {
        owner_id: this.ownerId,
        ...(err instanceof Error ? { error: err.message } : {}),
      })
    }
  }

  async sendApplicantConfirmation(
    e: ApplicantConfirmation & { applicantId: string; applicationId: string },
  ): Promise<void> {
    try {
      const rendered = await renderEmail('application_received', {
        candidateFirstName: e.candidateFirstName,
        jobTitle: e.jobTitle,
        companyLabel: e.companyLabel,
      })
      const send = async () =>
        sendEmail({
          to: e.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          fromName: e.companyLabel,
          template: 'application_received',
        })
      let result = await send()
      if (!result.ok && result.retryable) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        result = await send()
      }
      await this.writeEvent(
        result.ok ? 'email_sent' : 'email_failed',
        {
          to: 'applicant',
          template: 'application_received',
          ...(result.simulated ? { simulated: true } : {}),
          ...(!result.ok
            ? {}
            : 'messageId' in result && result.messageId
              ? { message_id: result.messageId }
              : {}),
        },
        { applicantId: e.applicantId, applicationId: e.applicationId },
      )
    } catch (err) {
      logger.error('sendApplicantConfirmation failed', {
        owner_id: this.ownerId,
        ...(err instanceof Error ? { error: err.message } : {}),
      })
    }
  }

  async alertOwnerResumeFailed(e: ResumeFailedAlert): Promise<void> {
    try {
      const text = buildResumeFailedMessage({
        jobTitle: e.jobTitle,
        applicantName: e.applicantName,
      })
      await this.telegram(text)
      const rendered = await renderEmail('owner_resume_failed', {
        jobTitle: e.jobTitle,
        applicantName: e.applicantName,
        settingsUrl: `${env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
      })
      await sendEmail({
        to: e.ownerEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        fromName: emailFrom(),
        template: 'owner_resume_failed',
      })
    } catch (err) {
      logger.error('alertOwnerResumeFailed failed', {
        owner_id: this.ownerId,
        ...(err instanceof Error ? { error: err.message } : {}),
      })
    }
  }
}

/** First name for email greeting (docs/09 §2.1). */
export function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0]
  return first ?? fullName.trim()
}
