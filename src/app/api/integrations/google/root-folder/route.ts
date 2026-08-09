import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { decryptSecret } from '@/lib/crypto'
import { getScopedIntegration, buildGoogleOAuthClient } from '@/lib/integrations/resolve'
import { createDriveFolder } from '@/lib/storage/google-drive'
import { assertCapability, requireWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'
import { z } from 'zod'

export const runtime = 'nodejs'

const Body = z
  .object({
    folder_id: z.string().min(4).optional(),
    create_named: z.string().trim().min(2).max(80).optional(),
  })
  .strict()
  .refine((v) => v.folder_id || v.create_named, { message: 'folder_id or create_named required' })

/** POST /api/integrations/google/root-folder — docs/05 §4.6 + docs/07 §4. */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const body = Body.parse(await request.json())
  const resolved = await getScopedIntegration(supabase, refForScope(scope), 'google_drive')
  const row = resolved?.row ?? null
  if (!row || row.status !== 'active' || !row.credentials_encrypted) {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'Google Drive is not connected.')
  }
  // Mutating the ORG row's config = integrations.manage (docs/11 §2).
  if (resolved?.level === 'org') assertCapability(scope, 'integrations.manage')

  let folderId = body.folder_id
  let folderName: string | null = null
  if (!folderId && body.create_named) {
    const oauth2 = buildGoogleOAuthClient()
    oauth2.setCredentials(JSON.parse(decryptSecret(row.credentials_encrypted)))
    const created = await createDriveFolder(oauth2, body.create_named)
    folderId = created.id
    folderName = body.create_named
  }

  const { error } = await supabase
    .from('integrations')
    .update({ config: { ...row.config, root_folder_id: folderId } })
    .eq('id', row.id)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not save the root folder.', { cause: error })

  return { ok: true, root_folder_id: folderId, root_folder_name: folderName }
})
