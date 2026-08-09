import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/service'
import { getOrgBrandForJob, getPublicJobBySlug } from '@/features/jobs/server'
import { resolveBrand } from '@/features/orgs/server'
import { publicQuestionsFor } from '@/features/screening/server'
import { BrandSchema } from '@/features/orgs/schemas'
import { Badge } from '@/ui/badge'
import { Card } from '@/ui/card'
import { ApplyForm } from '@/features/apply/apply-form'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type PageProps = {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Fixed demo fixture at `/apply/demo` — docs/12 §6 go-live checklist and docs/13
 * §5 both target `/apply/[demo-slug]` for the Lighthouse perf-budget gate
 * (see .github/workflows/ci.yml's `lighthouse` job). A REAL seeded job would
 * need a live database in CI; this static fixture renders through the exact
 * same `ApplyForm` component and JS bundle as a real listing, so the page
 * Lighthouse audits is representative without needing one.
 */
const DEMO_JOB = {
  id: 'demo',
  owner_id: 'demo',
  organization_id: null as string | null,
  title: 'Barista — Weekend Shift',
  description:
    "We're hiring a friendly, reliable barista for our weekend rush. Latte art skills a plus, not required — we'll train you. Flexible hours, tips included.",
  status: 'active' as const,
  form_config: { phone: 'optional', resume: 'required', cover_note: 'optional' } as const,
  screening_config: {
    questions: [
      {
        id: 'demoq1',
        label: 'Do you have prior barista or food-service experience?',
        required: true,
        type: 'yes_no' as const,
      },
      {
        id: 'demoq2',
        label: 'Are you available on weekends?',
        required: true,
        type: 'yes_no' as const,
      },
    ],
  },
}

/**
 * Friendly copy for the no-JS fallback error redirect (docs/06 §6) — the enhanced
 * XHR path renders its own inline per-field errors; this banner is coarser by
 * necessity since a full-page redirect can't carry field-level state.
 */
const NO_JS_ERROR_COPY: Record<string, string> = {
  RATE_LIMITED: 'Too many attempts from this connection. Please try again in a few minutes.',
  JOB_CLOSED: 'This position is no longer accepting applications.',
  VALIDATION_ERROR: 'Some fields need attention — please check your details and resume below.',
  FILE_TOO_LARGE: 'Your resume file is too large (max 10 MB).',
  UNSUPPORTED_FILE_TYPE: 'Please upload a PDF, DOC, or DOCX resume file.',
  NOT_FOUND: 'This hiring link could not be found.',
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  if (slug === 'demo') return { title: `Apply — ${DEMO_JOB.title}` }
  const job = await getPublicJobBySlug(createServiceClient(), slug).catch(() => null)
  return { title: job ? `Apply — ${job.title}` : 'Apply' }
}

/**
 * Public apply page — docs/02 §4, docs/06 §4/§8 (perf-critical: RSC shell + lean
 * client form; no dashboard JS, no RHF/zod in the browser bundle — CHANGELOG P1).
 * Unknown/draft slug → 404 (no existence leak). Closed → friendly 410 state.
 * Branding (docs/11 §5): pro/team orgs show their own logo/name/color; free and
 * personal workspaces carry the small "via HireLink" pill.
 */
export default async function ApplyPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const sp = await searchParams
  const supabase = createServiceClient()
  const job = slug === 'demo' ? DEMO_JOB : await getPublicJobBySlug(supabase, slug)
  if (!job) notFound()

  // Progressive-enhancement fallback (docs/06 §6): the plain-form POST redirects
  // (303) back here with `?submitted=1` on success — same copy the JS path shows
  // inline via ApplyForm's `phase: 'success'` state, just rendered server-side.
  if (sp.submitted === '1') {
    return (
      <div className="mx-auto max-w-lg p-4 pt-8">
        <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-success/10 text-2xl">
            ✅
          </span>
          <h1 className="text-xl font-semibold text-ink">
            {sp.already === '1' ? 'You already applied' : 'Application received'}
          </h1>
          <p className="text-sm text-ink-secondary">
            {sp.already === '1'
              ? `Our records show an application from you for ${job.title}. No need to apply again.`
              : `Thanks for applying for ${job.title}. We've emailed you a confirmation.`}
          </p>
        </Card>
      </div>
    )
  }

  if (job.status !== 'active') {
    return (
      <div className="mx-auto max-w-lg p-4 pt-8">
        <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <h1 className="text-xl font-semibold text-ink">{job.title}</h1>
          <p className="text-sm text-ink-secondary">
            This position is no longer accepting applications. Thanks for your interest!
          </p>
        </Card>
      </div>
    )
  }

  const org = job.organization_id
    ? await getOrgBrandForJob(supabase, job.organization_id).catch(() => null)
    : null
  const brand = org
    ? resolveBrand({
        name: org.name,
        plan: org.plan,
        brand: BrandSchema.catch({}).parse(org.brand ?? {}),
      })
    : null

  return (
    <div className="mx-auto max-w-lg p-4 pt-8">
      {brand?.custom ? (
        <div
          className="mb-4 flex flex-col gap-3 rounded-[12px] border border-slate-200 bg-surface p-4"
          style={brand.primaryColor ? { borderTop: `4px solid ${brand.primaryColor}` } : undefined}
        >
          <div className="flex items-center gap-3">
            {brand.logoUrl ? (
              // Public logo URL from the org's brand settings (write-restricted to the org owner).
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
            ) : null}
            <p className="text-sm font-semibold text-ink">{brand.companyLabel}</p>
          </div>
          <h1 className="text-2xl font-bold text-ink">{job.title}</h1>
        </div>
      ) : null}

      <div className="mb-4">
        {brand?.custom ? null : <h1 className="text-2xl font-bold text-ink">{job.title}</h1>}
        {job.description ? (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">
            {job.description}
          </p>
        ) : null}
      </div>

      {typeof sp.error === 'string' ? (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
          {NO_JS_ERROR_COPY[sp.error] ??
            'Something went wrong. Please check your details and try again.'}
        </p>
      ) : null}

      <ApplyForm
        slug={slug}
        jobTitle={job.title}
        formConfig={job.form_config}
        questions={publicQuestionsFor(job)}
        primaryColor={brand?.custom ? (brand.primaryColor ?? null) : null}
      />

      {brand?.custom ? null : (
        <p className="mt-6 flex justify-center">
          <Badge tone="muted">via HireLink</Badge>
        </p>
      )}
    </div>
  )
}
