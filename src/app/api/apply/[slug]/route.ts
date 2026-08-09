import { after } from 'next/server'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit, clientIp } from '@/lib/ratelimit'
import { getPublicJobBySlug, getOrgBrandForJob } from '@/features/jobs/server'
import { ApplyInput } from '@/features/applications/schemas'
import { validateResumeFile } from '@/features/applications/file-validation'
import { createApplicationForJob, getOwnerNotificationPrefs } from '@/features/applications/server'
import { resolveBrand } from '@/features/orgs/server'
import { resolveDriveStorage } from '@/lib/integrations/resolve'
import { Notifications, firstName } from '@/lib/notifications'
import { logger, errorSummary } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ slug: string }> }

const APPLY_RATE_LIMIT = { limit: 5, windowSec: 600 } // docs/05 §3: 5 / 10 min / IP

/**
 * POST /api/apply/:slug — docs/05 §4.2, flow per docs/03 §5.
 * Idempotent (duplicates → 201 already_applied). Integration failures NEVER 5xx
 * this endpoint (D4): Drive/Telegram/Email issues are absorbed and journaled.
 */
export const POST = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { slug } = await ctx.params

  // 1) Rate limit (docs/05 §3; disabled-mode header when Upstash absent).
  const ip = clientIp(request)
  const limited = await checkRateLimit(
    `apply:${ip}`,
    APPLY_RATE_LIMIT.limit,
    APPLY_RATE_LIMIT.windowSec,
  )
  if (!limited.success) {
    throw new AppError(
      ErrorCode.RATE_LIMITED,
      'Too many attempts. Please try again in a few minutes.',
      {
        details: { retry_after: limited.retryAfterSec },
      },
    )
  }

  // 2) Parse + validate body (zod incl. honeypot `website` — docs/05 §4.2).
  const form = await request.formData()
  const input = ApplyInput.parse({
    full_name: form.get('full_name'),
    email: form.get('email'),
    phone: form.get('phone') === null || form.get('phone') === '' ? undefined : form.get('phone'),
    cover_note:
      form.get('cover_note') === null || form.get('cover_note') === ''
        ? undefined
        : form.get('cover_note'),
    source: form.get('source') || 'direct',
    website: form.get('website') ?? '',
  })

  // 3) Job must exist + be active (404 unknown; 410 closed — docs/05 §4.2).
  const service = createServiceClient()
  const job = await getPublicJobBySlug(service, slug)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  if (job.status !== 'active') {
    throw new AppError(ErrorCode.JOB_CLOSED, 'This position is no longer accepting applications.')
  }

  // 4) form_config enforcement: hidden fields are dropped; required resume must exist (docs/02 §4.2).
  if (job.form_config.phone === 'hidden') input.phone = undefined
  if (job.form_config.cover_note === 'hidden') input.cover_note = undefined

  const file = form.get('resume')
  let resume: {
    data: Buffer
    originalName: string
    validated: ReturnType<typeof validateResumeFile>
  } | null = null
  if (file instanceof File && file.size > 0) {
    const data = Buffer.from(await file.arrayBuffer())
    const validated = validateResumeFile(data) // throws 400 / 413 / 415 (docs/05 §2/§5)
    resume = { data, originalName: file.name || 'resume', validated }
  } else if (job.form_config.resume === 'required') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Some fields are invalid.', {
      details: { resume: ['Resume is required for this position.'] },
    })
  }

  if (input.cover_note) {
    // cover_note travels on the application record for the detail view.
    // (stored into source_meta by the service — see createApplicationForJob input mapping)
  }

  // 5) Storage provider — org Drive wins for org jobs, else creator's personal (docs/11 §3);
  //    degrades to null when nothing is connected (docs/03 §6).
  const jobOrg = job.organization_id ?? null
  const orgRow = jobOrg ? await getOrgBrandForJob(service, jobOrg).catch(() => null) : null
  const brand = orgRow
    ? resolveBrand({
        name: orgRow.name,
        plan: orgRow.plan,
        brand: orgRow.brand as {
          logo_url?: string | null
          primary_color?: string | null
          email_from_name?: string | null
        },
      })
    : null
  const drive = await resolveDriveStorage(service, { ownerId: job.owner_id, orgId: jobOrg })

  // 6) Create application + events + resume attempt (service handles absorption).
  const result = await createApplicationForJob(
    service,
    {
      id: job.id,
      owner_id: job.owner_id,
      organization_id: jobOrg,
      title: job.title,
      drive_folder_id: (job as { drive_folder_id?: string | null }).drive_folder_id ?? null,
    },
    input,
    resume,
    drive,
  )

  if (!result.alreadyApplied && input.cover_note) {
    await service
      .from('applications')
      .update({ source_meta: { cover_note: input.cover_note } })
      .eq('id', result.applicationId)
  }

  // 7) Notifications — fire-and-forget AFTER the response (docs/03 §5; `after` keeps
  // the work alive in serverless). Everything below is best-effort by design.
  after(async () => {
    try {
      const prefs = await getOwnerNotificationPrefs(service, job.owner_id)
      const notifications = new Notifications(service, job.owner_id, { orgId: jobOrg })
      // Brand voice (docs/11 §9): org from-name/name wins; else the owner's name.
      const companyLabel = brand?.companyLabel ?? prefs?.name ?? 'The employer'

      if (prefs?.notifyTelegram) {
        await notifications.notifyOwnerNewApplication({
          jobTitle: result.jobTitle,
          applicantName: result.applicantName,
          email: result.applicantEmail,
          phone: result.applicantPhone,
          resumeUploaded: result.resumeUploaded,
          applicationId: result.applicationId,
          applicantId: result.applicantId,
        })
      }
      if (prefs?.notifyApplicantEmail && !result.alreadyApplied) {
        await notifications.sendApplicantConfirmation({
          to: result.applicantEmail,
          candidateFirstName: firstName(result.applicantName),
          jobTitle: result.jobTitle,
          companyLabel,
          applicantId: result.applicantId,
          applicationId: result.applicationId,
        })
      }
      if (result.resumeFailed && prefs) {
        await notifications.alertOwnerResumeFailed({
          jobTitle: result.jobTitle,
          applicantName: result.applicantName,
          ownerEmail: prefs.email,
          companyLabel,
        })
      }
    } catch (err) {
      logger.error('apply notifications crashed (absorbed)', { slug, ...errorSummary(err) })
    }
  })

  // docs/05 §4.2: 201 for both fresh and duplicate submissions.
  return Response.json(
    { ok: true, application_id: result.applicationId, already_applied: result.alreadyApplied },
    { status: 201 },
  )
})
