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

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
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
export default async function ApplyPage({ params }: PageProps) {
  const { slug } = await params
  const supabase = createServiceClient()
  const job = await getPublicJobBySlug(supabase, slug)
  if (!job) notFound()

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
      <ApplyForm
        slug={slug}
        jobTitle={job.title}
        formConfig={job.form_config}
        questions={publicQuestionsFor(job)}
      />

      {brand?.custom ? null : (
        <p className="mt-6 flex justify-center">
          <Badge tone="muted">via HireLink</Badge>
        </p>
      )}
    </div>
  )
}
