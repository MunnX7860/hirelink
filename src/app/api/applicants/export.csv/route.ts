import { handleRoute } from '@/lib/errors'
import { csvDocument, csvFilename } from '@/lib/csv'
import { ListApplicantsQuery } from '@/features/applicants/schemas'
import { EXPORT_MAX_ROWS, listApplicantsForExport } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/**
 * GET /api/applicants/export.csv — docs/05 §4.4. Same filters as the list;
 * capped at EXPORT_MAX_ROWS; contact data only, never resume bytes/links.
 */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const { searchParams } = new URL(request.url)
  const q = ListApplicantsQuery.parse({
    q: searchParams.get('q') ?? undefined,
    tag_id: searchParams.get('tag_id') ?? undefined,
    limit: String(EXPORT_MAX_ROWS),
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
