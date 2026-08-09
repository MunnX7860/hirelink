import 'server-only'

import { render } from '@react-email/render'
import { createElement } from 'react'
import { ApplicationReceivedEmail } from '@/emails/application-received'
import { OwnerResumeFailedEmail } from '@/emails/owner-resume-failed'
import { OrgInviteEmail } from '@/emails/org-invite'
import { env } from '@/lib/env'

/**
 * Template registry — docs/09 §2: keyed map, `required_vars` enforced by types,
 * subject built per template. Adding a template = add a registry entry; it cannot
 * render without its declared variables.
 */

export interface ApplicationReceivedCtx {
  candidateFirstName: string
  jobTitle: string
  companyLabel: string
}
export interface OwnerResumeFailedCtx {
  jobTitle: string
  applicantName: string
  settingsUrl: string
}
export interface OrgInviteCtx {
  orgName: string
  inviterName: string
  role: string
  joinUrl: string
}

const registry = {
  application_received: {
    render: (ctx: ApplicationReceivedCtx) => createElement(ApplicationReceivedEmail, ctx),
    subject: (ctx: ApplicationReceivedCtx) => `Application received — ${ctx.jobTitle}`,
  },
  owner_resume_failed: {
    render: (ctx: OwnerResumeFailedCtx) => createElement(OwnerResumeFailedEmail, ctx),
    subject: (ctx: OwnerResumeFailedCtx) => `Resume upload failed — ${ctx.jobTitle}`,
  },
  org_invite: {
    render: (ctx: OrgInviteCtx) => createElement(OrgInviteEmail, ctx),
    subject: (ctx: OrgInviteCtx) => `${ctx.inviterName} invited you to ${ctx.orgName} on HireLink`,
  },
} as const

export type TemplateId = keyof typeof registry
export type TemplateCtx<T extends TemplateId> = Parameters<(typeof registry)[T]['subject']>[0]

export async function renderEmail<T extends TemplateId>(
  template: T,
  ctx: TemplateCtx<T>,
): Promise<{ subject: string; html: string; text: string }> {
  const entry = registry[template]
  // Type-safe per template id; the union forces a small cast at the seam.
  const element = entry.render(ctx as never)
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
  return { subject: entry.subject(ctx as never), html, text }
}

export function emailFrom(): string {
  return env.EMAIL_FROM
}
