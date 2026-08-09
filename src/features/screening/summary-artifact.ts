import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import { refForScope, type Scope } from '@/features/orgs/scope'
import { markIntegrationError, resolveDriveStorage } from '@/lib/integrations/resolve'
import { StorageProviderError } from '@/lib/storage/types'
import {
  groupResultsForDisplay,
  type DisplayResultRow,
  type ResultCategoryValue,
} from '@/features/screening/session-schemas'

/**
 * Screening summary artifact (docs/17 §13) — on session completion, ONE
 * immutable JSON summary is uploaded next to the job's resumes in Drive
 * (`{Job}/AI Screenings/screening-<date>-<shortid>.json`). Write-once: retry
 * completions never rewrite it (the dashboard stays the live source).
 * Everything here is D4-absorbed: an artifact failure NEVER fails a session.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

export const SCREENINGS_FOLDER_NAME = 'AI Screenings'
export const SUMMARY_ARTIFACT_VERSION = 1
/** Parity with resume uploads (docs/03 §6): one retry, retryable-only, 5 s. */
const UPLOAD_RETRY_DELAY_MS = 5_000

/** `screening-YYYY-MM-DD-<sessionId first 8>.json` (17 §13 verbatim shape). */
export function summaryFilename(completedAt: string | Date, sessionId: string): string {
  const iso = typeof completedAt === 'string' ? completedAt : completedAt.toISOString()
  return `screening-${iso.slice(0, 10)}-${sessionId.slice(0, 8)}.json`
}

export interface SummarySessionMeta {
  id: string
  pool: string
  instruction: string
  max_results: number
  provider: string
  model: string
  prompt_version: string
  engine: string
  pool_size: number
  processed: number
  failed: number
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface ScreeningSummaryArtifact {
  artifact: 'hirelink/screening-summary'
  version: number
  generated_at: string
  job: { id: string; title: string }
  session: SummarySessionMeta & { created_by: string }
  /** Aggregates incl. per-category counts (advisory AI tallies, 17 §8). */
  counts: {
    pool_size: number
    processed: number
    failed: number
    strong_match: number
    possible_match: number
    review_required: number
    lower_priority: number
  }
  /** Display order: shortlist → beyond top-N → review → lower priority → failed. */
  results: Array<{
    application_id: string
    applicant_name: string
    status: 'ok' | 'failed'
    category: ResultCategoryValue | null
    rank: number | null
    score: number | null
    reasons: string[]
    evidence: string[]
    /** INSUFFICIENT_EVIDENCE markers preserved verbatim (17 §8.1). */
    uncertainties: string[]
    error: string | null
  }>
}

/**
 * Pure artifact builder (unit-tested): grouped top-N-upper-bound semantics are
 * applied through the SAME read-model helper the dashboard uses, so the file
 * always agrees with the on-screen truth.
 */
export function buildScreeningSummary(input: {
  session: SummarySessionMeta
  job: { id: string; title: string }
  rows: DisplayResultRow[]
  createdByName: string
  generatedAt?: Date
}): ScreeningSummaryArtifact {
  const { session } = input
  const grouped = groupResultsForDisplay(input.rows, session.max_results)
  const ordered = [
    ...grouped.shortlist,
    ...grouped.beyondTopN,
    ...grouped.review_required,
    ...grouped.lower_priority,
    ...grouped.failed,
  ]
  const countOf = (category: ResultCategoryValue) =>
    input.rows.filter((r) => r.status === 'ok' && r.category === category).length
  return {
    artifact: 'hirelink/screening-summary',
    version: SUMMARY_ARTIFACT_VERSION,
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    job: { id: input.job.id, title: input.job.title },
    session: {
      ...session,
      created_by: input.createdByName,
    },
    counts: {
      pool_size: session.pool_size,
      processed: session.processed,
      failed: session.failed,
      strong_match: countOf('strong_match'),
      possible_match: countOf('possible_match'),
      review_required: countOf('review_required'),
      lower_priority: countOf('lower_priority'),
    },
    results: ordered.map((r) => ({
      application_id: r.applicationId,
      applicant_name: r.applicantName,
      status: r.status === 'failed' ? 'failed' : 'ok',
      category: r.category,
      rank: r.rank,
      score: r.score,
      reasons: r.reasons,
      evidence: r.evidence,
      uncertainties: r.uncertainties,
      error: r.status === 'failed' ? (r.error ?? 'AI error') : null,
    })),
  }
}

export type SummaryOutcome = 'written' | 'skipped' | 'absorbed'

interface SessionArtifactRow {
  id: string
  job_id: string
  owner_id: string
  pool: string
  instruction: string
  max_results: number
  provider: string
  model: string
  prompt_version: string
  engine: string
  status: string
  pool_size: number
  processed: number
  failed: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  summary_folder_id: string | null
  summary_file_id: string | null
  job: { id: string; title: string; drive_folder_id: string | null }
}

/**
 * Write the §13 artifact for a COMPLETED session (called by both engines at
 * their completion point). Never throws — D4 by contract.
 */
export async function writeScreeningSummaryArtifact(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<SummaryOutcome> {
  let driveIntegrationId: string | null = null
  try {
    const { data, error } = await client
      .from('ai_screening_sessions')
      .select(
        'id, job_id, owner_id, pool, instruction, max_results, provider, model, prompt_version, engine, status, pool_size, processed, failed, created_at, started_at, completed_at, summary_folder_id, summary_file_id, job:jobs!inner(id, title, drive_folder_id)',
      )
      .eq('id', sessionId)
      .maybeSingle()
    if (error || !data) {
      logger.warn('screening summary: session load failed', {
        session_id: sessionId,
        ...errorSummary(error),
      })
      return 'absorbed'
    }
    const row = data as unknown as SessionArtifactRow & {
      job: SessionArtifactRow['job'] | SessionArtifactRow['job'][]
    }
    const job = Array.isArray(row.job) ? (row.job[0] ?? null) : row.job
    if (!job) return 'absorbed'
    if (row.summary_file_id) return 'skipped' // write-once (17 §13 immutability)
    if (row.status !== 'completed') return 'skipped'

    const drive = await resolveDriveStorage(client, refForScope(scope))
    if (!drive) {
      logger.info('screening summary skipped — Drive not connected', { session_id: sessionId })
      return 'skipped'
    }
    driveIntegrationId = drive.integrationId

    // Result rows + applicant names (owner's own Drive — recruiter-facing file).
    const { data: resultRows, error: rowsError } = await client
      .from('ai_screening_results')
      .select(
        'application_id, status, error, rank, category, score, reasons, evidence, uncertainties, applicant:applicants!inner(full_name)',
      )
      .eq('session_id', sessionId)
    if (rowsError) throw rowsError
    const rows: DisplayResultRow[] = (
      (resultRows ?? []) as unknown as Array<
        Record<string, unknown> & {
          applicant: { full_name: string | null }[] | { full_name: string | null } | null
        }
      >
    ).map((r) => {
      const embed = Array.isArray(r.applicant) ? (r.applicant[0] ?? null) : r.applicant
      return {
        applicationId: r.application_id as string,
        applicantId: '',
        applicantName: embed?.full_name ?? 'Candidate',
        status: r.status as DisplayResultRow['status'],
        error: (r.error as string | null) ?? null,
        category: (r.category as DisplayResultRow['category']) ?? null,
        rank: (r.rank as number | null) ?? null,
        score: (r.score as number | null) ?? null,
        reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
        evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
        uncertainties: Array.isArray(r.uncertainties) ? (r.uncertainties as string[]) : [],
      }
    })

    const { data: ownerRow } = await client
      .from('users')
      .select('full_name')
      .eq('id', row.owner_id)
      .maybeSingle()
    const createdByName = (ownerRow as { full_name: string | null } | null)?.full_name ?? 'Unknown'

    const summary = buildScreeningSummary({
      session: {
        id: row.id,
        pool: row.pool,
        instruction: row.instruction,
        max_results: row.max_results,
        provider: row.provider,
        model: row.model,
        prompt_version: row.prompt_version,
        engine: row.engine,
        pool_size: row.pool_size,
        processed: row.processed,
        failed: row.failed,
        created_at: row.created_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
      },
      job: { id: job.id, title: job.title },
      rows,
      createdByName,
    })
    const filename = summaryFilename(row.completed_at ?? new Date(), row.id)

    // Folder: own cache → any sibling session's cache (same job) → create (07 §4).
    let folderId = row.summary_folder_id ?? (await siblingFolderId(client, row.job_id, row.id))
    if (!folderId) {
      let jobFolderId = job.drive_folder_id
      if (!jobFolderId) {
        jobFolderId = (await drive.storage.ensureJobFolder({ id: job.id, title: job.title }))
          .folderId
        const { error: cacheError } = await client
          .from('jobs')
          .update({ drive_folder_id: jobFolderId })
          .eq('id', job.id)
        if (cacheError)
          logger.warn('screening summary: job folder cache write failed (non-fatal)', {
            ...errorSummary(cacheError),
          })
      }
      folderId = (await drive.storage.ensureFolder(SCREENINGS_FOLDER_NAME, jobFolderId)).folderId
    }

    const data2 = Buffer.from(JSON.stringify(summary, null, 2), 'utf8')
    const uploaded = await uploadOnceWithRetry(drive.storage, {
      folderId,
      filename,
      mime: 'application/json',
      data: data2,
    })

    const { error: updateError } = await client
      .from('ai_screening_sessions')
      .update({ summary_folder_id: folderId, summary_file_id: uploaded.fileId })
      .eq('id', sessionId)
    if (updateError) {
      logger.warn('screening summary: file id cache write failed (file exists in Drive)', {
        session_id: sessionId,
        ...errorSummary(updateError),
      })
    }
    logger.info('screening summary artifact written', {
      session_id: sessionId,
      file_id: uploaded.fileId,
      results: rows.length,
    })
    return 'written'
  } catch (err) {
    // D4 (17 §13): the artifact must never fail or block the session.
    logger.error('screening summary artifact failed — absorbed (D4)', {
      session_id: sessionId,
      ...errorSummary(err),
    })
    if (err instanceof StorageProviderError && err.integrationBroken && driveIntegrationId) {
      await markIntegrationError(client, driveIntegrationId)
    }
    return 'absorbed'
  }
}

async function siblingFolderId(
  client: Client,
  jobId: string,
  sessionId: string,
): Promise<string | null> {
  const { data } = await client
    .from('ai_screening_sessions')
    .select('summary_folder_id')
    .eq('job_id', jobId)
    .not('summary_folder_id', 'is', null)
    .neq('id', sessionId)
    .limit(1)
    .maybeSingle()
  const folderId = (data as { summary_folder_id: string | null } | null)?.summary_folder_id
  return folderId ?? null
}

/** docs/03 §6 house pattern: single retry, retryable-classified errors only. */
async function uploadOnceWithRetry(
  storage: {
    uploadFile(input: {
      folderId: string
      filename: string
      mime: string
      data: Buffer
    }): Promise<{ fileId: string }>
  },
  input: { folderId: string; filename: string; mime: string; data: Buffer },
): Promise<{ fileId: string }> {
  try {
    return await storage.uploadFile(input)
  } catch (err) {
    if (!(err instanceof StorageProviderError) || !err.retryable) throw err
    await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS))
    return storage.uploadFile(input)
  }
}
