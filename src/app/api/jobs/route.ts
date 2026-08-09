import { NextResponse } from 'next/server'
import { handleRoute } from '@/lib/errors'
import { env } from '@/lib/env'
import { CreateJobInput, JobStatus, type JobRow } from '@/features/jobs/schemas'
import { createJob, listJobs } from '@/features/jobs/server'
import { requireWorkspace } from '@/features/orgs/server'
import { z } from 'zod'

export const runtime = 'nodejs'

/** POST /api/jobs — docs/05 §4.1. 201 → Job + apply_url. */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const input = CreateJobInput.parse(await request.json())
  const job = await createJob(supabase, scope, input)

  return NextResponse.json(
    { ...(job as JobRow), apply_url: `${env.NEXT_PUBLIC_APP_URL}/apply/${job.slug}` },
    { status: 201 },
  )
})

const ListQuery = z.object({
  status: JobStatus.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** GET /api/jobs — docs/05 §4.1. { data, next_cursor } scoped (docs/11 §1) with per-job counts. */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const { searchParams } = new URL(request.url)
  const q = ListQuery.parse({
    status: searchParams.get('status') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  })
  return listJobs(supabase, scope, { status: q.status, limit: q.limit, cursor: q.cursor })
})
