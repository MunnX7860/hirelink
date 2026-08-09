import 'server-only'

/**
 * StorageProvider — docs/03 §4. Files live wherever the provider says
 * (Phase 1: owner-owned Google Drive, docs/07); the DB stores references only (D2).
 */

export interface StoredFolder {
  folderId: string
}

export interface StoredFile {
  fileId: string
}

export interface StoredFileMetadata {
  name: string
  size: number
}

export interface StorageProvider {
  /** Lazily create `{root}/Jobs/{Title}—{jobId[:8]}/` (docs/07 §4); safe to call repeatedly. */
  ensureJobFolder(job: { id: string; title: string }): Promise<StoredFolder>
  uploadFile(input: {
    folderId: string
    filename: string
    mime: string
    data: Buffer
  }): Promise<StoredFile>
  /** Server-side bytes fetch for the authed streaming route (docs/07 §6). */
  downloadFile(fileId: string): Promise<{ data: Buffer; name: string; mime: string }>
  getFileMetadata(fileId: string): Promise<StoredFileMetadata>
  deleteFile(fileId: string): Promise<void>
}

/**
 * Thrown by provider impls; `retryable` drives the one-retry policy (docs/03 §6),
 * `integrationBroken` flips the integration row to status='error' + banner.
 */
export class StorageProviderError extends Error {
  readonly retryable: boolean
  readonly integrationBroken: boolean
  constructor(
    message: string,
    options: { retryable?: boolean; integrationBroken?: boolean; cause?: unknown },
  ) {
    super(message)
    this.name = 'StorageProviderError'
    this.retryable = options.retryable ?? false
    this.integrationBroken = options.integrationBroken ?? false
    this.cause = options.cause
  }
}
