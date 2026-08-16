import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { renderEmail } from '@/emails/registry'
import { sendEmail } from '@/lib/notifications/email'
import {
  buildNewApplicationMessage,
  buildResumeFailedMessage,
  sendTelegramMessage,
} from '@/lib/notifications/telegram'
import {
  resolveTelegram,
  resolveGmailSender,
  markIntegrationError,
} from '@/lib/integrations/resolve'
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

  /**
   * The workspace's connected Gmail, if any (docs/09 §1). Resolved per send
   * rather than cached on the instance: a `Notifications` object can outlive a
   * disconnect inside a long `after()` block, and sending from a revoked grant
   * would fail noisily instead of quietly falling back to the platform sender.
   */
  private async gmailSender() {
    try {
      return await resolveGmailSender(this.client, {
        ownerId: this.ownerId,
        orgId: this.opts.orgId ?? null,
      })
    } catch (err) {
      // Never let sender resolution sink a send — degrade to the platform transport.
      logger.error('gmail sender resolution failed (falling back)', {
        owner_id: this.ownerId,
        ...(err instanceof Error ? { error: err.message } : {}),
      })
      return null
    }
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

    // docs/08 §3: 401 (invalid token) / 403 (bot blocked) -> integration status='error'
    // + settings banner. Shared platform bots (docs/11 §3) aren't the org's credential
    // to fix, so a broken shared token is logged instead of flipping the org's row.
    const onPermanentFailure = async (code: string | undefined) => {
      if (creds.shared) {
        logger.error('shared Telegram bot token rejected', { code })
        return
      }
      await markIntegrationError(this.client, creds.integrationId).catch((err) => {
        logger.error('markIntegrationError (telegram) failed', {
          integration_id: creds.integrationId,
          ...(err instanceof Error ? { error: err.message } : {}),
        })
      })
    }

    const first = await sendTelegramMessage({
      botToken: creds.botToken,
      chatId: creds.chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    })
    if (first.ok) return { ok: true }
    if (!first.retryable) {
      await onPermanentFailure(first.code)
      return { ok: false, code: first.code }
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    const second = await sendTelegramMessage({
      botToken: creds.botToken,
      chatId: creds.chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    })
    if (second.ok) return { ok: true }
    if (!second.retryable) await onPermanentFailure(second.code)
    return { ok: false, code: second.code }
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
      const sender = await this.gmailSender()
      const send = async () =>
        sendEmail({
          to: e.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          fromName: e.companyLabel,
          template: 'application_received',
          sender,
        })
      let result = await send()
      if (!result.ok && result.retryable) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        result = await send()
      }
      // A revoked Gmail grant is the owner's to fix — flag it so Settings shows
      // the reconnect banner instead of silently dropping every future email.
      if (!result.ok && result.integrationBroken && sender) {
        await markIntegrationError(this.client, sender.integrationId).catch((err) => {
          logger.error('markIntegrationError (gmail) failed', {
            integration_id: sender.integrationId,
            ...(err instanceof Error ? { error: err.message } : {}),
          })
        })
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

  /**
   * Journals a confirmation email deliberately NOT sent because the candidate
   * did not qualify (docs/09 §2). Without this the timeline would be silent for
   * those applicants, making an intentional skip look identical to a delivery
   * failure. No email is attempted; this only writes the audit record.
   */
  async recordApplicantEmailSkipped(e: {
    reason: 'does_not_meet_mandatory' | 'review_required'
    applicantId: string
    applicationId: string
  }): Promise<void> {
    try {
      await this.writeEvent(
        'email_skipped',
        { to: 'applicant', template: 'application_received', reason: e.reason },
        { applicantId: e.applicantId, applicationId: e.applicationId },
      )
    } catch (err) {
      logger.error('recordApplicantEmailSkipped failed', {
        owner_id: this.ownerId,
        ...(err instanceof Error ? { error: err.message } : {}),
      })
    }
  }

  async alertOwnerResumeFailed(e: ResumeFailedAlert): Promise<void> {
    try {
      const ids = {
        ...(e.applicantId ? { applicantId: e.applicantId } : {}),
        ...(e.applicationId ? { applicationId: e.applicationId } : {}),
      }

      const text = buildResumeFailedMessage({
        jobTitle: e.jobTitle,
        applicantName: e.applicantName,
      })
      const telegramResult = await this.telegram(text)
      await this.writeEvent(
        telegramResult.ok ? 'telegram_sent' : 'telegram_failed',
        { to: 'owner', context: 'resume_failed' },
        ids,
      )

      const rendered = await renderEmail('owner_resume_failed', {
        jobTitle: e.jobTitle,
        applicantName: e.applicantName,
        settingsUrl: `${env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
      })
      const send = async () =>
        sendEmail({
          to: e.ownerEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          template: 'owner_resume_failed',
        })
      let emailResult = await send()
      if (!emailResult.ok && emailResult.retryable) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        emailResult = await send()
      }
      await this.writeEvent(
        emailResult.ok ? 'email_sent' : 'email_failed',
        {
          to: 'owner',
          template: 'owner_resume_failed',
          ...(emailResult.simulated ? { simulated: true } : {}),
          ...(emailResult.ok && 'messageId' in emailResult && emailResult.messageId
            ? { message_id: emailResult.messageId }
            : {}),
        },
        ids,
      )
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
