import { after } from 'next/server'
import { ZodError } from 'zod'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit, clientIp } from '@/lib/ratelimit'
import { getPublicJobBySlug, getOrgBrandForJob } from '@/features/jobs/server'
import { ApplyInput } from '@/features/applications/schemas'
import { validateResumeFile } from '@/features/applications/file-validation'
import { createApplicationForJob, getOwnerNotificationPrefs } from '@/features/applications/server'
import { parseScreeningConfig, validateAnswers, AnswersInput } from '@/features/screening/schemas'
import { evaluateScreening } from '@/features/screening/engine'
import { persistAnswersAndVerdict } from '@/features/screening/server'
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
 *
 * Progressive enhancement (docs/06 §6): the public form's `<form action method>`
 * targets this route directly so it works with JS disabled. Distinguishing a
 * plain browser navigation (needs an HTML redirect) from the enhanced XHR/fetch
 * path (needs JSON) uses the standard `Sec-Fetch-Mode` request header — browsers
 * set it to `navigate` ONLY for real top-level navigations (which is exactly what
 * a no-JS `<form>` submit produces) and never for `fetch`/`XMLHttpRequest`/API
 * clients (Playwright's `request.post`, curl, etc.), so no client-side signal or
 * cooperation is needed and every existing JSON-consuming caller is unaffected.
 */
export const POST = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { slug } = await ctx.params
  const origin = new URL(request.url).origin
  const isBrowserNavigation = request.headers.get('sec-fetch-mode') === 'navigate'

  // Parsed first (cheap) so it's available even if everything below throws.
  const form = await request.formData()

  try {
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

    // 3b) Questionnaire answers (docs/17 §5): validate against the job's question
    //     set (PRIVATE rules stay server-side; unknown ids dropped). Missing required
    //     answers → 400 with per-question field errors keyed `answers.<id>`.
    const screening = parseScreeningConfig(job.screening_config)
    let answersCleaned: ReturnType<typeof validateAnswers>['cleaned'] = {}
    if (screening.questions.length > 0) {
      let rawAnswers: unknown = {}
      const rawField = form.get('answers')
      if (typeof rawField === 'string' && rawField.trim() !== '') {
        if (rawField.length > 8 * 1024) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 'Some fields are invalid.', {
            details: { answers: ['Answers payload is too large.'] },
          })
        }
        try {
          const parsedJson: unknown = JSON.parse(rawField)
          rawAnswers = AnswersInput.parse(parsedJson)
        } catch {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 'Some fields are invalid.', {
            details: { answers: ['Answers payload is malformed.'] },
          })
        }
      }
      const validation = validateAnswers(screening.questions, rawAnswers as Record<string, unknown>)
      if (!validation.ok) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'Some fields are invalid.', {
          details: validation.fieldErrors,
        })
      }
      answersCleaned = validation.cleaned
    }
    // Computed early (pure, no DB) so the Drive upload below can route into a
    // Qualified/Not Qualified/Needs Review subfolder — docs/07 §4. Null when the
    // job has no mandatory questions, in which case the resume stays flat.
    // persistAnswersAndVerdict (step 6b) re-derives the same verdict when it
    // writes screening_status — both calls are pure over the same inputs, so
    // they always agree; kept separate to avoid threading DB state in early.
    const screeningVerdict = evaluateScreening(
      screening.questions,
      answersCleaned as Record<string, boolean | string | number | string[]>,
    ).status

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
      screeningVerdict,
    )

    if (!result.alreadyApplied && input.cover_note) {
      await service
        .from('applications')
        .update({ source_meta: { cover_note: input.cover_note } })
        .eq('id', result.applicationId)
    }

    // 6b) Questionnaire: persist answers + compute the deterministic verdict
    //     (docs/17 §4–§5). First-write-wins on duplicates; absorbed on failure (D4).
    if (!result.alreadyApplied && screening.questions.length > 0) {
      await persistAnswersAndVerdict({
        client: service,
        jobOwnerId: job.owner_id,
        applicationId: result.applicationId,
        applicantId: result.applicantId,
        config: screening,
        answers: answersCleaned,
      })
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
            applicantId: result.applicantId,
            applicationId: result.applicationId,
          })
        }
      } catch (err) {
        logger.error('apply notifications crashed (absorbed)', { slug, ...errorSummary(err) })
      }
    })

    if (isBrowserNavigation) {
      // Plain-form fallback (docs/06 §6): classic POST-redirect-GET back to the
      // apply page, which renders the same success copy the JS path shows inline.
      const qs = result.alreadyApplied ? '?submitted=1&already=1' : '?submitted=1'
      return Response.redirect(`${origin}/apply/${slug}${qs}`, 303)
    }

    // docs/05 §4.2: 201 for both fresh and duplicate submissions.
    return Response.json(
      { ok: true, application_id: result.applicationId, already_applied: result.alreadyApplied },
      { status: 201 },
    )
  } catch (err) {
    if (!isBrowserNavigation) throw err // preserve the existing JSON error envelope (docs/05 §2)

    // Plain-form fallback: no JSON consumer on the other end — redirect back to
    // the apply page with a coarse error code it can render as a friendly banner.
    const code =
      err instanceof AppError
        ? err.code
        : err instanceof ZodError
          ? ErrorCode.VALIDATION_ERROR
          : ErrorCode.INTERNAL
    if (code === ErrorCode.INTERNAL) {
      logger.error('apply (no-js) failed', { slug, ...errorSummary(err) })
    }
    return Response.redirect(`${origin}/apply/${slug}?error=${encodeURIComponent(code)}`, 303)
  }
})
