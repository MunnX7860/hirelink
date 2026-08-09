import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { getScopedIntegration, driveOAuthClientFor } from '@/lib/integrations/resolve'
import { listDriveFolders } from '@/lib/storage/google-drive'
import { requireWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'

export const runtime = 'nodejs'

/** GET /api/integrations/google/folders — docs/05 §4.6: folder list for the root picker
 *  (workspace-precedence row, docs/11 §3). */
export const GET = handleRoute(async () => {
  const { supabase, scope } = await requireWorkspace()

  const resolved = await getScopedIntegration(supabase, refForScope(scope), 'google_drive')
  const row = resolved?.row ?? null
  if (!row || row.status !== 'active' || !row.credentials_encrypted) {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'Google Drive is not connected.')
  }

  const oauth2 = driveOAuthClientFor(supabase, row)
  try {
    const folders = await listDriveFolders(oauth2)
    return { data: folders }
  } catch (err) {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'Could not list your Drive folders.', {
      cause: err,
    })
  }
})
