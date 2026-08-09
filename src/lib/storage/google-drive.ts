import 'server-only'

import { Readable } from 'node:stream'
// Subpath import: the googleapis index pulls ~200 API type surfaces and blows
// past the sandbox's RAM during typecheck/build (docs/12 §8 cost posture).
import { drive, type drive_v3 } from 'googleapis/build/src/apis/drive'
import type { OAuth2Client } from 'google-auth-library'
import type { StorageProvider, StoredFileMetadata } from '@/lib/storage/types'
import { StorageProviderError } from '@/lib/storage/types'

/** docs/07 §5: 30s per Drive API attempt (the retry-with-backoff half lives in the callers). */
const DRIVE_TIMEOUT_MS = 30_000

/**
 * Google Drive StorageProvider — docs/07. Scope `drive.file` only (D1);
 * OAuth grant + token lifecycle in lib/integrations/resolve.ts.
 */
export class GoogleDriveStorage implements StorageProvider {
  private readonly drive: drive_v3.Drive
  private readonly rootFolderId: string

  constructor(oauth2: OAuth2Client, rootFolderId: string) {
    this.drive = drive({ version: 'v3', auth: oauth2 })
    this.rootFolderId = rootFolderId
  }

  private wrap(err: unknown): never {
    const anyErr = err as {
      code?: number | string
      message?: string
      errors?: Array<{ reason?: string }>
    }
    const status = Number(anyErr?.code)
    const reason = anyErr?.errors?.[0]?.reason ?? ''
    const msg = anyErr?.message ?? 'Drive request failed'

    if (msg.includes('invalid_grant')) {
      throw new StorageProviderError('Google Drive authorization expired — reconnect required', {
        integrationBroken: true,
        cause: err,
      })
    }
    if (status === 404 || reason === 'notFound') {
      throw new StorageProviderError('Drive folder/file not found', {
        integrationBroken: true,
        cause: err,
      })
    }
    if (status === 403 || reason.includes('RateLimit') || status === 429 || status >= 500) {
      throw new StorageProviderError('Drive is rate-limiting or unavailable — retryable', {
        retryable: true,
        cause: err,
      })
    }
    throw new StorageProviderError(msg, { cause: err })
  }

  /** Create (or locate) a child folder by exact name. Drive folders are non-unique; we key off cached ids in the DB. */
  private async ensureChildFolder(name: string, parentId: string): Promise<string> {
    try {
      const created = await this.drive.files.create(
        {
          requestBody: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          },
          fields: 'id',
          supportsAllDrives: false,
        },
        { timeout: DRIVE_TIMEOUT_MS },
      )
      const id = created.data.id
      if (!id) throw new Error('Drive did not return a folder id')
      return id
    } catch (err) {
      this.wrap(err)
    }
  }

  async ensureJobFolder(job: { id: string; title: string }) {
    const jobsRoot = await this.ensureChildFolder('Jobs', this.rootFolderId)
    const folder = await this.ensureChildFolder(
      `${sanitizeDriveName(job.title)}—${job.id.slice(0, 8)}`,
      jobsRoot,
    )
    return { folderId: folder }
  }

  async ensureFolder(name: string, parentId: string) {
    const folderId = await this.ensureChildFolder(sanitizeDriveName(name, 80), parentId)
    return { folderId }
  }

  async uploadFile(input: { folderId: string; filename: string; mime: string; data: Buffer }) {
    try {
      const res = await this.drive.files.create(
        {
          requestBody: { name: sanitizeDriveName(input.filename, 120), parents: [input.folderId] },
          media: { mimeType: input.mime, body: Readable.from(input.data) },
          fields: 'id',
          supportsAllDrives: false,
        },
        { timeout: DRIVE_TIMEOUT_MS },
      )
      const fileId = res.data.id
      if (!fileId) throw new Error('Drive did not return a file id')
      return { fileId }
    } catch (err) {
      this.wrap(err)
    }
  }

  async downloadFile(fileId: string) {
    try {
      const [meta, media] = await Promise.all([
        this.drive.files.get(
          { fileId, fields: 'name,mimeType', supportsAllDrives: false },
          { timeout: DRIVE_TIMEOUT_MS },
        ),
        this.drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: false },
          { responseType: 'arraybuffer', timeout: DRIVE_TIMEOUT_MS },
        ),
      ])
      return {
        data: Buffer.from(media.data as ArrayBuffer),
        name: (meta.data.name as string) ?? 'resume',
        mime: (meta.data.mimeType as string) ?? 'application/octet-stream',
      }
    } catch (err) {
      this.wrap(err)
    }
  }

  async getFileMetadata(fileId: string): Promise<StoredFileMetadata> {
    try {
      const res = await this.drive.files.get(
        { fileId, fields: 'name,size', supportsAllDrives: false },
        { timeout: DRIVE_TIMEOUT_MS },
      )
      return { name: res.data.name ?? 'file', size: Number(res.data.size ?? 0) }
    } catch (err) {
      this.wrap(err)
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.drive.files.delete(
        { fileId, supportsAllDrives: false },
        { timeout: DRIVE_TIMEOUT_MS },
      )
    } catch (err) {
      this.wrap(err)
    }
  }
}

/** List the user's own folders for the root picker (docs/07 §4). */
export async function listDriveFolders(oauth2: OAuth2Client) {
  const client = drive({ version: 'v3', auth: oauth2 })
  const res = await client.files.list(
    {
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      orderBy: 'name',
      pageSize: 100,
      spaces: 'drive',
    },
    { timeout: DRIVE_TIMEOUT_MS },
  )
  return (res.data.files ?? []).map((f) => ({ id: f.id as string, name: f.name as string }))
}

/** Create a brand root folder ("HireLink") and return its id. */
export async function createDriveFolder(oauth2: OAuth2Client, name: string) {
  const client = drive({ version: 'v3', auth: oauth2 })
  const res = await client.files.create(
    {
      requestBody: {
        name: sanitizeDriveName(name, 80),
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    },
    { timeout: DRIVE_TIMEOUT_MS },
  )
  if (!res.data.id) throw new Error('Drive did not return a folder id')
  return { id: res.data.id }
}

/** Docs/07 §4: strip illegal chars; names are cosmetic — IDs are the identity. */
export function sanitizeDriveName(name: string, max = 80): string {
  return name
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}
