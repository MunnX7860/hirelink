import { handleRoute } from '@/lib/errors'
import { CreateNoteInput } from '@/features/applicants/schemas'
import { createNote } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** POST /api/notes — docs/05 §4.5 (journals note_added), scoped (docs/11 §1). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope, user } = await requireWorkspace()

  const input = CreateNoteInput.parse(await request.json())
  return createNote(supabase, scope, input, user.id)
})
