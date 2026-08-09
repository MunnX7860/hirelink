import { handleRoute } from '@/lib/errors'
import { deleteNote } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** DELETE /api/notes/:id — docs/05 §4.5 (own notes only — RLS owner policy). */
export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase } = await requireWorkspace()

  const { id } = await ctx.params
  await deleteNote(supabase, id)
})
