import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { encryptSecret, decryptSecret, maskSecret } from '@/lib/crypto'
import { env } from '@/lib/env'
import {
  getIntegration,
  getOrgIntegration,
  getScopedIntegration,
  markIntegrationError,
  resolveDriveStorage,
  type IntegrationRef,
} from '@/lib/integrations/resolve'
import type { Scope } from '@/features/orgs/scope'
import { applyScope, isRowInScope, refForScope } from '@/features/orgs/scope'
import { makeGeminiProvider, tolerantJsonParse } from '@/lib/ai/gemini'
import {
  AI_TEMPERATURE,
  PROMPT_VERSIONS,
  RESUME_TEXT_CAP,
  buildJobDescriptionPrompt,
  buildProfileExtractPrompt,
  buildResumeParsePrompt,
  buildSocialPostPrompt,
  buildSummaryPrompt,
  truncateWords,
} from '@/lib/ai/prompts'
import { extractResumeText } from '@/lib/ai/extract'
import type { AiGenerateRequest, AIProvider } from '@/lib/ai/types'
import { AI_CAPABILITIES } from '@/lib/ai/types'
import {
  PARSED_RESUME_JSON_SCHEMA,
  ParsedResumeSchema,
  RESUME_PROFILE_JSON_SCHEMA,
  ResumeProfileSchema,
  SUMMARY_JSON_SCHEMA,
  SummaryOutputSchema,
  decodeSummaryCache,
  encodeSummaryCache,
  profileStale,
  type CandidateSummaryCache,
  type ParsedResume,
  type ResumeProfile,
  type SummaryOutput,
} from '@/features/ai/schemas'

/**
 * AI features — docs/10 in full, docs/05 §4.7. BYOK key resolution is WORKSPACE-scoped
 * in Phase 4 (docs/11 §3): the org BYOK pool wins when switched into an org, otherwise
 * the calling member's own key. AI is strictly optional (G5) — nothing here ever runs
 * without an explicit button press; absence of a key degrades to 400 AI_NOT_CONFIGURED.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

interface ResolvedAi {
  integrationId: string
  provider: AIProvider
}

async function resolveAiOrNull(client: Client, ref: IntegrationRef): Promise<ResolvedAi | null> {
  const resolved = await getScopedIntegration(client, ref, 'ai')
  const row = resolved?.row ?? null
  if (!row || row.status !== 'active' || !row.credentials_encrypted) return null
  try {
    const apiKey = decryptSecret(row.credentials_encrypted)
    return { integrationId: row.id, provider: makeGeminiProvider({ apiKey }) }
  } catch (err) {
    logger.error('ai key decrypt failed', { owner_id: ref.ownerId, ...errorSummary(err) })
    return null
  }
}

/** docs/05 §4.7 + docs/10 §6 degradation contract. */
async function requireAi(client: Client, ref: IntegrationRef): Promise<ResolvedAi> {
  const ai = await resolveAiOrNull(client, ref)
  if (!ai) {
    throw new AppError(ErrorCode.AI_NOT_CONFIGURED, 'Add your Gemini key in Settings → AI')
  }
  return ai
}

/** Uniform failure mapping (docs/10 §6) — exact user-facing strings are product copy. */
async function generateOrThrow(
  ai: ResolvedAi,
  client: Client,
  req: AiGenerateRequest,
  friendly: string,
): Promise<string> {
  const result = await ai.provider.generate(req)
  if (result.ok) return result.text
  if (result.integrationBroken) {
    await markIntegrationError(client, ai.integrationId)
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Your Gemini key was rejected — reconnect it in Settings → AI.',
    )
  }
  if (result.code === 'ai_rate_limited') {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'AI is busy — try again in a minute.')
  }
  throw new AppError(
    ErrorCode.INTEGRATION_ERROR,
    friendly,
    result.status ? { details: { status: result.status } } : undefined,
  )
}

// ── Connect / BYOK (docs/10 §1) ────────────────────────────────────────────────

export interface AiIntegrationSafeShape {
  type: 'ai'
  status: 'active'
  config: {
    provider: 'gemini'
    model: string
    capabilities: readonly string[]
    key_hint: string
  }
}

export async function verifyAndStoreAiKey(
  client: Client,
  scope: Scope,
  apiKey: string,
): Promise<AiIntegrationSafeShape> {
  const provider = makeGeminiProvider({ apiKey })
  const check = await provider.verifyKey()
  if (!check.ok) {
    if (check.integrationBroken) {
      throw new AppError(
        ErrorCode.INTEGRATION_ERROR,
        'Google rejected that key — copy a fresh one from Google AI Studio.',
      )
    }
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Couldn’t reach Google to verify the key — try again in a moment.',
    )
  }

  const config = {
    provider: 'gemini' as const,
    model: provider.model,
    capabilities: [...AI_CAPABILITIES],
    key_hint: maskSecret(apiKey), // masked display only (docs/10 §1 write-only surface)
  }
  const credentials = encryptSecret(apiKey)

  // Select-then-write (docs/04 §3.10). Org workspace → the row becomes the org BYOK
  // pool (docs/11 §3); caller capability integrations.manage is asserted in the route.
  const orgId = scope.kind === 'org' ? scope.orgId : null
  const existing = orgId
    ? await getOrgIntegration(client, orgId, 'ai')
    : await getIntegration(client, scope.ownerId, 'ai')
  if (existing) {
    const { error } = await client
      .from('integrations')
      .update({ status: 'active', credentials_encrypted: credentials, config })
      .eq('id', existing.id)
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not save the key.', { cause: error })
  } else {
    const { error } = await client.from('integrations').insert({
      owner_id: scope.ownerId,
      organization_id: orgId,
      type: 'ai',
      status: 'active',
      credentials_encrypted: credentials,
      config,
    })
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not save the key.', { cause: error })
  }

  return { type: 'ai', status: 'active', config }
}

/** Read model + status for pages (no credentials — workspace-precedence safe subset, docs/11 §3). */
export async function getAiState(
  client: Client,
  scope: Scope,
): Promise<{
  status: 'active' | 'error'
  model: string
  keyHint: string | null
  capabilities: string[]
  level: 'org' | 'personal'
} | null> {
  const resolved = await getScopedIntegration(client, refForScope(scope), 'ai')
  const row = resolved?.row ?? null
  if (!row) return null
  const config = row.config as { model?: string; key_hint?: string; capabilities?: string[] }
  return {
    status: row.status === 'active' ? 'active' : 'error',
    model: config.model ?? 'gemini-2.0-flash',
    keyHint: config.key_hint ?? null,
    capabilities: config.capabilities ?? [...AI_CAPABILITIES],
    level: resolved?.level ?? 'personal',
  }
}

// ── Shared: text extraction with cache (docs/10 §3) ───────────────────────────

interface ResumeContextRow {
  id: string
  application_id: string
  mime_type: string
  storage_file_id: string | null
  upload_status: string
  parsed_text: string | null
  ai_parsed: unknown
}

async function getResumeText(
  client: Client,
  ref: IntegrationRef,
  resume: ResumeContextRow,
): Promise<string | null> {
  if (resume.parsed_text && resume.parsed_text.trim().length > 0) return resume.parsed_text
  if (resume.upload_status !== 'uploaded' || !resume.storage_file_id) return null

  const drive = await resolveDriveStorage(client, ref)
  if (!drive) return null // Drive disconnected — degrade gracefully (docs/03 §6)
  try {
    const file = await drive.storage.downloadFile(resume.storage_file_id)
    const text = await extractResumeText(file.data, resume.mime_type)
    if (text) {
      const { error } = await client
        .from('resumes')
        .update({ parsed_text: text })
        .eq('id', resume.id)
      if (error) logger.warn('parsed_text cache write failed', { ...errorSummary(error) })
    }
    return text
  } catch (err) {
    logger.warn('resume download for extraction failed', { ...errorSummary(err) })
    return null
  }
}

// ── Resume parsing (POST /api/ai/parse-resume) ────────────────────────────────

export async function parseResumeFeature(
  client: Client,
  scope: Scope,
  resumeId: string,
): Promise<{ parsed: ParsedResume; cached: boolean }> {
  const { data, error } = await client
    .from('resumes')
    .select(
      'id, application_id, mime_type, storage_file_id, upload_status, parsed_text, ai_parsed, application:applications!inner(job:jobs!inner(owner_id, organization_id))',
    )
    .eq('id', resumeId)
    .maybeSingle()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the resume.', { cause: error })
  if (!data) throw new AppError(ErrorCode.NOT_FOUND, 'Resume not found.')
  // Workspace containment via the parent job (docs/11 §1 — 404 semantics).
  const parentJob = (
    (data as { application?: { job?: { owner_id: string; organization_id: string | null } } })
      .application ?? {}
  ).job
  if (!parentJob || !isRowInScope(parentJob, scope)) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Resume not found.')
  }
  const resume = data as unknown as ResumeContextRow

  // Cache hit — validated before reuse (a corrupted cache is recomputed).
  if (resume.ai_parsed) {
    const cached = ParsedResumeSchema.safeParse(resume.ai_parsed)
    if (cached.success) return { parsed: cached.data, cached: true }
  }

  const ref = refForScope(scope)
  const ai = await requireAi(client, ref)
  if (resume.upload_status !== 'uploaded' || !resume.storage_file_id) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'No readable file is attached to this application.',
    )
  }
  const text = await getResumeText(client, ref, resume)
  if (!text) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Couldn’t read text from this file (scanned PDFs and .doc aren’t supported).',
    )
  }

  const basePrompt = buildResumeParsePrompt(text.slice(0, RESUME_TEXT_CAP))
  const req: Omit<AiGenerateRequest, 'prompt'> = {
    temperature: AI_TEMPERATURE.parsing,
    maxOutputTokens: 1024,
    jsonSchema: PARSED_RESUME_JSON_SCHEMA,
  }

  // docs/10 §4: zod-validate; invalid output → ONE retry with stricter prompt.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: a previous attempt returned invalid output. Return ONLY valid JSON matching the required schema — no commentary.`
    const raw = await generateOrThrow(ai, client, { ...req, prompt }, 'Couldn’t parse this resume.')
    const json = tolerantJsonParse(raw)
    if (json) {
      const parsed = ParsedResumeSchema.safeParse(json)
      if (parsed.success) {
        const { error: cacheError } = await client
          .from('resumes')
          .update({ ai_parsed: parsed.data })
          .eq('id', resume.id)
        if (cacheError) logger.warn('ai_parsed cache write failed', { ...errorSummary(cacheError) })
        return { parsed: parsed.data, cached: false }
      }
    }
    logger.warn('ai parse output invalid; retrying', { attempt, resume_id: resume.id })
  }

  throw new AppError(
    ErrorCode.INTEGRATION_ERROR,
    'Couldn’t parse this resume — you can still read it directly.',
  )
}

// ── Resume profile, parse v2 (POST /api/ai/applicant-profile — docs/17 §6) ───

/** Latest UPLOADED resume across the applicant's applications (profile source, 17 §6). */
async function getLatestApplicantResume(
  client: Client,
  applicantId: string,
): Promise<ResumeContextRow | null> {
  const { data, error } = await client
    .from('resumes')
    .select(
      'id, application_id, mime_type, storage_file_id, upload_status, parsed_text, ai_parsed, application:applications!inner(applicant_id)',
    )
    .eq('application.applicant_id', applicantId)
    .eq('upload_status', 'uploaded')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant’s resumes.', {
      cause: error,
    })
  return ((data ?? [])[0] as unknown as ResumeContextRow | undefined) ?? null
}

interface StoredProfileRow {
  payload: unknown
  source_resume_id: string | null
  prompt_version: string
  updated_at: string
}

async function getStoredProfile(
  client: Client,
  applicantId: string,
): Promise<StoredProfileRow | null> {
  const { data, error } = await client
    .from('applicant_profiles')
    .select('payload, source_resume_id, prompt_version, updated_at')
    .eq('applicant_id', applicantId)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the parsed profile.', { cause: error })
  return (data as StoredProfileRow | null) ?? null
}

async function requireApplicantInScope(
  client: Client,
  scope: Scope,
  applicantId: string,
): Promise<void> {
  const { data, error } = await applyScope(
    client.from('applicants').select('id, owner_id, organization_id'),
    scope,
  )
    .eq('id', applicantId)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', { cause: error })
  if (!data) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')
}

export interface ApplicantProfileView {
  profile: ResumeProfile | null
  updated_at: string | null
  prompt_version: string | null
  /** 17 §6 staleness badge (newer resume arrived / prompt version moved). */
  stale: boolean
  /** A readable resume exists to build from (drives the Build button). */
  buildable: boolean
}

/** Page read-model (server-side render; never exposes anything beyond the profile). */
export async function getApplicantProfile(
  client: Client,
  scope: Scope,
  applicantId: string,
): Promise<ApplicantProfileView | null> {
  const { data, error } = await applyScope(
    client.from('applicants').select('id, owner_id, organization_id'),
    scope,
  )
    .eq('id', applicantId)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', { cause: error })
  if (!data) return null

  const [stored, latest] = await Promise.all([
    getStoredProfile(client, applicantId),
    getLatestApplicantResume(client, applicantId),
  ])
  let profile: ResumeProfile | null = null
  if (stored) {
    const parsed = ResumeProfileSchema.safeParse(stored.payload)
    if (parsed.success) profile = parsed.data // corrupted cache renders as "no profile"
  }
  return {
    profile,
    updated_at: stored?.updated_at ?? null,
    prompt_version: stored?.prompt_version ?? null,
    stale: profileStale(stored, latest?.id ?? null),
    buildable: latest !== null,
  }
}

export async function applicantProfileFeature(
  client: Client,
  scope: Scope,
  input: { applicant_id: string },
): Promise<{ profile: ResumeProfile; cached: boolean; updated_at: string }> {
  await requireApplicantInScope(client, scope, input.applicant_id)

  const [stored, latest] = await Promise.all([
    getStoredProfile(client, input.applicant_id),
    getLatestApplicantResume(client, input.applicant_id),
  ])

  // Cache rule (17 §6): fresh profile → reuse WITHOUT a model call (key not even consulted).
  if (stored && !profileStale(stored, latest?.id ?? null)) {
    const cached = ResumeProfileSchema.safeParse(stored.payload)
    if (cached.success) return { profile: cached.data, cached: true, updated_at: stored.updated_at }
  }

  const ref = refForScope(scope)
  const ai = await requireAi(client, ref)

  if (!latest) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'No uploaded resume is attached to this applicant.',
    )
  }
  const text = await getResumeText(client, ref, latest)
  if (!text) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Couldn’t read text from this resume (scanned PDFs and .doc aren’t supported).',
    )
  }

  const basePrompt = buildProfileExtractPrompt(text.slice(0, RESUME_TEXT_CAP))
  const req: Omit<AiGenerateRequest, 'prompt'> = {
    temperature: AI_TEMPERATURE.parsing,
    maxOutputTokens: 2048,
    jsonSchema: RESUME_PROFILE_JSON_SCHEMA,
  }

  // docs/10 §4: zod-validate; invalid output → ONE retry with stricter prompt.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nIMPORTANT: a previous attempt returned invalid output. Return ONLY valid JSON matching the required schema — no commentary.`
    const raw = await generateOrThrow(
      ai,
      client,
      { ...req, prompt },
      'Couldn’t build a profile from this resume.',
    )
    const json = tolerantJsonParse(raw)
    if (json) {
      const parsed = ResumeProfileSchema.safeParse(json)
      if (parsed.success) {
        const { error: upsertError } = await client.from('applicant_profiles').upsert(
          {
            applicant_id: input.applicant_id,
            payload: parsed.data,
            source_resume_id: latest.id,
            prompt_version: PROMPT_VERSIONS.profile_extract,
          },
          { onConflict: 'applicant_id' },
        )
        if (upsertError)
          logger.error('applicant_profiles upsert failed', { ...errorSummary(upsertError) })
        return { profile: parsed.data, cached: false, updated_at: new Date().toISOString() }
      }
    }
    logger.warn('ai profile output invalid; retrying', {
      attempt,
      applicant_id: input.applicant_id,
    })
  }

  throw new AppError(
    ErrorCode.INTEGRATION_ERROR,
    'Couldn’t build a profile from this resume — you can still read it directly.',
  )
}

// ── Candidate summary (POST /api/ai/summarize-applicant) ─────────────────────

export async function summarizeApplicantFeature(
  client: Client,
  scope: Scope,
  input: { applicant_id: string; force: boolean },
): Promise<{ summary: string; strengths: string[]; cached: boolean; generated_at: string }> {
  const { data: applicant, error: applicantError } = await applyScope(
    client.from('applicants').select('id, full_name, ai_summary, owner_id, organization_id'),
    scope,
  )
    .eq('id', input.applicant_id)
    .maybeSingle()
  if (applicantError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', {
      cause: applicantError,
    })
  if (!applicant) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')

  const row = applicant as { id: string; full_name: string; ai_summary: string | null }
  if (!input.force) {
    const cached = decodeSummaryCache(row.ai_summary)
    if (cached) {
      return {
        summary: cached.summary,
        strengths: cached.strengths,
        cached: true,
        generated_at: cached.generated_at,
      }
    }
  }

  const ai = await requireAi(client, refForScope(scope))

  // Context: newest application (+ cover note), its freshest uploaded resume, recent notes.
  const { data: app } = await client
    .from('applications')
    .select('id, applied_at, source_meta, job:jobs!inner(title)')
    .eq('applicant_id', input.applicant_id)
    .order('applied_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const application = app as {
    id: string
    applied_at: string
    source_meta: unknown
    job: { title: string } | null
  } | null

  let resumeText: string | null = null
  if (application) {
    const { data: resumes } = await client
      .from('resumes')
      .select(
        'id, application_id, mime_type, storage_file_id, upload_status, parsed_text, ai_parsed',
      )
      .eq('application_id', application.id)
      .eq('upload_status', 'uploaded')
      .order('created_at', { ascending: false })
      .limit(1)
    const resume = (resumes ?? [])[0] as ResumeContextRow | undefined
    if (resume) {
      const text = await getResumeText(client, refForScope(scope), resume)
      if (text) resumeText = text.slice(0, RESUME_TEXT_CAP)
    }
  }

  const { data: notes } = await client
    .from('notes')
    .select('body')
    .eq('applicant_id', input.applicant_id)
    .order('created_at', { ascending: false })
    .limit(5)

  const prompt = buildSummaryPrompt({
    resumeText,
    jobTitle: application?.job?.title ?? 'the role',
    appliedAt: application?.applied_at ?? '',
    coverNote:
      ((application?.source_meta as Record<string, unknown> | null)?.cover_note as string) ?? null,
    notes: ((notes ?? []) as Array<{ body: string }>).map((n) => n.body),
  })

  let output: SummaryOutput | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await generateOrThrow(
      ai,
      client,
      {
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n\nIMPORTANT: a previous attempt returned invalid output. Return ONLY valid JSON.`,
        temperature: AI_TEMPERATURE.parsing,
        maxOutputTokens: 512,
        jsonSchema: SUMMARY_JSON_SCHEMA,
      },
      'Couldn’t summarise this candidate.',
    )
    const json = tolerantJsonParse(raw)
    if (json) {
      const parsed = SummaryOutputSchema.safeParse(json)
      if (parsed.success) {
        output = parsed.data
        break
      }
    }
  }
  if (!output) {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'Couldn’t summarise this resume.')
  }

  // Contract enforcement (docs/10 §3): ≤120 words + at most 3 strengths.
  const finalOutput: SummaryOutput = {
    summary: truncateWords(output.summary, 120),
    strengths: output.strengths.slice(0, 3),
  }
  const cache: CandidateSummaryCache = {
    ...finalOutput,
    generated_at: new Date().toISOString(),
    model: ai.provider.model,
  }
  const { error: cacheError } = await client
    .from('applicants')
    .update({ ai_summary: encodeSummaryCache(cache) })
    .eq('id', input.applicant_id)
  if (cacheError) logger.warn('ai_summary cache write failed', { ...errorSummary(cacheError) })

  const { error: eventError } = await client.from('timeline_events').insert({
    owner_id: scope.ownerId,
    applicant_id: input.applicant_id,
    application_id: application?.id ?? null,
    actor_id: scope.ownerId,
    type: 'ai_summary_generated',
    payload: { model: ai.provider.model, prompt_version: PROMPT_VERSIONS.summarize_candidate },
  })
  if (eventError) logger.error('ai_summary_generated event failed', { ...errorSummary(eventError) })

  return { ...finalOutput, cached: false, generated_at: cache.generated_at }
}

// ── Job description draft (POST /api/ai/generate/job-description) ────────────

export async function generateJobDescriptionFeature(
  client: Client,
  scope: Scope,
  input: { title: string; notes?: string | undefined },
): Promise<{ description: string }> {
  const ai = await requireAi(client, refForScope(scope))
  const text = await generateOrThrow(
    ai,
    client,
    {
      prompt: buildJobDescriptionPrompt(input),
      temperature: AI_TEMPERATURE.drafting,
      maxOutputTokens: 1024,
    },
    'Couldn’t draft a description — write it manually instead.',
  )
  if (text.trim().length === 0) {
    throw new AppError(ErrorCode.INTEGRATION_ERROR, 'AI returned an empty draft — try again.')
  }
  return { description: text.trim() }
}

// ── Social post (POST /api/ai/generate/social-post) ──────────────────────────

export const SOCIAL_POST_CAP = 280

export async function generateSocialPostFeature(
  client: Client,
  scope: Scope,
  input: {
    job_id: string
    tone: 'friendly' | 'professional' | 'urgent'
    platform: 'whatsapp' | 'instagram' | 'linkedin'
  },
): Promise<{ post: string; link: string }> {
  const { data: job, error: jobError } = await applyScope(
    client.from('jobs').select('id, title, slug, description, owner_id, organization_id'),
    scope,
  )
    .eq('id', input.job_id)
    .maybeSingle()
  if (jobError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the job.', { cause: jobError })
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')

  const ai = await requireAi(client, refForScope(scope))
  const raw = await generateOrThrow(
    ai,
    client,
    {
      prompt: buildSocialPostPrompt({
        title: (job as { title: string }).title,
        description: (job as { description: string | null }).description,
        tone: input.tone,
        platform: input.platform,
      }),
      temperature: AI_TEMPERATURE.drafting,
      maxOutputTokens: 200,
    },
    'Couldn’t draft a post — write it manually instead.',
  )

  // ≤280 chars with a clean word boundary (docs/10 §3 "1 post ≤ 280 chars + link line").
  let post = raw.trim().replace(/^["']+|["']+$/g, '')
  if (post.length > SOCIAL_POST_CAP) {
    const cut = post.slice(0, SOCIAL_POST_CAP - 1)
    post = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), SOCIAL_POST_CAP - 12))}…`
  }
  const link = `${env.NEXT_PUBLIC_APP_URL}/apply/${(job as { slug: string }).slug}`
  return { post, link }
}
