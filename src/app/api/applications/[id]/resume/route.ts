import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { getApplicationDetail } from '@/features/applications/server'
import { resolveDriveStorage } from '@/lib/integrations/resolve'
import { requireWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'
import { StorageProviderError } from '@/lib/storage/types'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/applications/:id/resume — docs/05 §4.8 + docs/07 §6.
 * The ONLY resume-bytes egress: owner-authed server-side stream from Drive.
 * Files are never shared publicly (D2) and never cached server-side.
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()

  const { id } = await ctx.params
  const detail = await getApplicationDetail(supabase, scope, id)
  if (!detail) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')

  const resume = detail.resumes.find((r) => r.upload_status === 'uploaded' && r.storage_file_id)
  if (!resume) throw new AppError(ErrorCode.NOT_FOUND, 'No stored resume for this application.')

  const drive = await resolveDriveStorage(supabase, refForScope(scope))
  if (!drive) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Google Drive is not connected — reconnect it in Settings to view resumes.',
    )
  }

  try {
    const file = await drive.storage.downloadFile(resume.storage_file_id as string)
    const safeName = resume.original_filename.replace(/[/\\:*?"<>|\r\n"]/g, ' ')
    return new Response(new Uint8Array(file.data), {
      headers: {
        'content-type': file.mime,
        'content-disposition': `inline; filename="${safeName}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof StorageProviderError) {
      throw new AppError(
        ErrorCode.INTEGRATION_ERROR,
        'Could not fetch the resume from Google Drive.',
        {
          cause: err,
        },
      )
    }
    throw err
  }
})
