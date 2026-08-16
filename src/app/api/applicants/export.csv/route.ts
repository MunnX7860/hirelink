import { handleRoute } from '@/lib/errors'
import { csvDocument, csvFilename } from '@/lib/csv'
import { ListApplicantsQuery } from '@/features/applicants/schemas'
import { listApplicantsForExport } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/**
 * GET /api/applicants/export.csv — docs/05 §4.4. Same filters as the list;
 * capped at EXPORT_MAX_ROWS; contact data only, never resume bytes/links.
 */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const { searchParams } = new URL(request.url)
  // Only the filter fields are parsed here. `limit` is deliberately NOT passed:
  // ListApplicantsQuery caps it at 100 (a pagination guard for the list view),
  // so feeding it EXPORT_MAX_ROWS made every export 400 with
  // "Number must be less than or equal to 100". listApplicantsForExport applies
  // EXPORT_MAX_ROWS itself, so the value was discarded even when it did parse.
  const q = ListApplicantsQuery.omit({ limit: true }).parse({
    q: searchParams.get('q') ?? undefined,
    tag_id: searchParams.get('tag_id') ?? undefined,
  })

  const rows = await listApplicantsForExport(supabase, scope, { q: q.q, tag_id: q.tag_id })
  const csv = csvDocument(
    ['full_name', 'email', 'phone', 'source', 'created_at', 'tags', 'applications_count'],
    rows.map((r) => [
      r.full_name,
      r.email,
      r.phone ?? '',
      r.source,
      r.created_at,
      r.tags.map((t) => t.name).join('|'),
      r.applications_count,
    ]),
  )

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFilename('hirelink-applicants')}"`,
      'cache-control': 'no-store',
    },
  })
})
