# 05 — API Specification

> Last updated 2026-08-07. Normative for all `/api/*` route handlers. Base URL: `{NEXT_PUBLIC_APP_URL}`. All JSON unless stated.
> Auth: Supabase session cookie via `@supabase/ssr` (owner endpoints) unless marked **PUBLIC**. Request/response field names match `04` exactly.

## 1. Conventions

- **Validation:** zod schemas in `features/*/schemas.ts`, shared client/server. All endpoints validate input; unknown fields rejected (`.strict()`).
- **IDs:** path params use UUIDs except public slug routes.
- **Timestamps:** ISO 8601 UTC. Responses use the DB column names (snake_case) — no DTO renaming (keep Phase 1–3 simple; revisit at Phase 4 public API).
- **Pagination (list endpoints):** `?cursor=<opaque>&limit=<1..100, default 50>`. Response: `{ data: [...], next_cursor: string | null }` — keyset pagination on `(created_at desc, id desc)` / `(applied_at, id)`.
- **Filtering/sorting** where listed via query params documented per endpoint.

## 2. Error Model (normative)

```jsonc
// non-2xx always:
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable summary",
    "details": { "email": ["Invalid email"] },
    "request_id": "req_...",
  },
}
```

| HTTP | code                    | When                                                                               |
| ---- | ----------------------- | ---------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`      | zod failure; `details` = field errors                                              |
| 401  | `UNAUTHORIZED`          | no/invalid session                                                                 |
| 403  | `FORBIDDEN`             | authenticated but not owner                                                        |
| 404  | `NOT_FOUND`             | entity missing **or** not owned (no existence leak)                                |
| 409  | `CONFLICT`              | uniqueness violation (e.g. duplicate tag name)                                     |
| 410  | `JOB_CLOSED`            | applying to non-active job                                                         |
| 413  | `FILE_TOO_LARGE`        | resume > 10 MB                                                                     |
| 415  | `UNSUPPORTED_FILE_TYPE` | resume not pdf/doc/docx                                                            |
| 402  | `PLAN_LIMIT`            | plan cap exceeded (Phase 4, 11 §4); `details` = `{ limit_key, used, limit, plan }` |
| 409  | `ALREADY_MEMBER`        | invite accept when the user already belongs to the org (Phase 4)                   |
| 410  | `INVITE_EXPIRED`        | invite token unknown/expired/already used (Phase 4 — no existence leak)            |
| 429  | `RATE_LIMITED`          | rate limit hit; includes `retry_after` in details                                  |
| 502  | `INTEGRATION_ERROR`     | upstream (Drive/Telegram/Resend/Gemini) failed on an owner-initiated action        |
| 500  | `INTERNAL`              | unhandled; logged with request_id                                                  |

Never leak stack traces/SQL/first-party env. `request_id` = `crypto.randomUUID()` per request, echoed in `x-request-id` header.

## 3. Rate Limits

| Route                            | Limit      | Key     |
| -------------------------------- | ---------- | ------- |
| `POST /api/apply/:slug`          | 5 / 10 min | IP      |
| `GET /api/apply/:slug` page-data | 60 / min   | IP      |
| All other owner endpoints        | 300 / min  | user id |
| `POST /api/integrations/*/test`  | 10 / min   | user id |

Implementation: Upstash Ratelimit fixed window via `lib/ratelimit.ts`; **env-gated** — if Upstash env absent (local dev), limits are skipped and a debug header `x-ratelimit: disabled` is sent. 429 responses are JSON per §2.

## 4. Endpoints

### 4.1 Jobs

#### `POST /api/jobs` — create job + hiring link

```jsonc
// body  (CreateJobInput)
{ "title": "Barista", "description": "…",
  "form_config": { "phone": "optional", "resume": "required", "cover_note": "hidden" } }
// 201 → Job
{ "id": "uuid", "slug": "k3x9p2qa", "status": "active", "apply_url": "https://…/apply/k3x9p2qa", /* all jobs cols */ }
```

Errors: 400, 401.

#### `GET /api/jobs` — list

Query: `status?=draft|active|closed`, pagination. Response `{ data: Job[], next_cursor }`. Each Job includes `application_count` (aggregate) and `new_count`.

#### `GET /api/jobs/:id` — detail

Response: `Job` + `stats: { by_status: Record<application_status, number> }`.

#### `PATCH /api/jobs/:id` — update

Body: any subset of `title, description, form_config, status` (status transitions draft→active→closed and active↔closed allowed). 200 → updated Job.

#### `DELETE /api/jobs/:id`

Cascades applications (04 §8). Confirm-client-side only. 204.

#### `POST /api/jobs/:id/move` (Phase 4)

Body `{ organization_id: uuid | null }` — moves the job (and exclusively-attached applicants, 11 §6.2) between the personal workspace and an org the caller belongs to. Permission: job creator, or org owner/admin of the source scope (11 §2). 402 `PLAN_LIMIT` when the move would push the target scope over `jobs.active`. 200 → updated Job. 404 when the job is outside the caller's current scope.

#### `GET /api/jobs/:slug/public` — **PUBLIC** form config for apply page

```jsonc
{
  "title": "Barista",
  "description": "…",
  "status": "active",
  "form_config": {/* as above */},
  // Phase 5 (17 §3.4): SANITIZED question schema — { id, label, required, type, options? } only.
  // `classification` and `rule` never leave the server.
  "questions": [
    { "id": "q8xk2p", "label": "Years of SQL experience?", "required": true, "type": "number" },
  ],
}
```

No owner info, no IDs beyond slug. 404 if slug unknown (drafts never leak).

### 4.2 Apply (public)

#### `POST /api/apply/:slug` — **PUBLIC**, `multipart/form-data`

Fields: `full_name` (2–200), `email`, `phone?`, `cover_note?`, `resume?`=file (per job's form_config rules), `source?` (≤60), `website` (honeypot — must be empty). **Phase 5:** `answers?` = JSON string ≤8 kB, `{ question_id: value }` against the job's questionnaire (17 §5) — unknown question ids are dropped (warn-logged), missing required answers → 400 with per-question field errors; the deterministic verdict (17 §4) is computed in-request and stored as `applications.screening_status`; duplicate applications do **not** overwrite first-submitted answers.
Rate-limited (§3) → validate MIME by magic bytes + size ≤10MB (§2 codes) → service flow exactly per `03 §5`.

```jsonc
// 201 (also 201 for duplicate application — idempotent, D8)
{ "ok": true, "application_id": "uuid", "already_applied": false }
```

Errors: 400, 410 (`JOB_CLOSED`), 413, 415, 429. **Never 5xx for integration failures** — Drive/Telegram/email failures are absorbed (03 §6).

### 4.3 Applications (owner)

#### `GET /api/applications`

Query: `job_id?`, `status?` (comma list), `q?` (Phase 2 full-text on applicant name/email), `tag_id?`, `date_from?`/`date_to?` (ISO dates over `applied_at`, per 02 §6 filters), `since?`, `cursor?`, `limit?` (≤100, default 50). Default = inbox view: any job, `status=new`, newest first. Items embed `applicant { full_name, email, phone }`, `job { id, title }`, `has_resume`, `resume_failed`, `tags[]`. Response: `{ data, next_cursor }` — cursor opaque (`applied_at_id` pair).

#### `GET /api/applications/:id`

Full detail: application + applicant + job + `resumes[]` (metadata only) + `notes[]` + `timeline[]` (latest 100) + `tags[]`.

#### `PATCH /api/applications/:id` — status / archive

```jsonc
{ "status": "shortlisted" } // any application_status; server records from/to timeline
// unarchive: { "status": "<restore>" } — client sends desired non-archived status
```

200 → updated application (embeds as in list).

#### `DELETE /api/applications/:id` (Phase 2)

Removes the application (DB cascades: `resumes[]`, its timeline rows). **Drive files remain** (07 §7) — response `{ ok: true, drive_files_kept: boolean }`; client warns before confirm. A `application_deleted` event is journaled on the applicant.

#### `PATCH /api/applications` — **bulk** (Phase 2, spec'd now)

Body: `{ "ids": uuid[] (≤100), "action": "set_status"|"archive"|"add_tag", "value": string }`. 200 → `{ updated: number }`. Partial failures: none-some atomic per row; result includes `{ failed_ids: uuid[] }`.

### 4.4 Applicants (Phase 2; spec'd now)

`GET /api/applicants` (`q?`, `tag_id?`, cursor pagination; items embed `tags[]`, `applications_count`, `last_applied_at`) · `GET /api/applicants/:id` (profile + their applications + `resumes`-free metadata + `notes[]` + `tags[]` + timeline latest 100) · `PATCH /api/applicants/:id` (`phone`, future fields).

`GET /api/applicants/export.csv` — CSV stream (`text/csv`, `Content-Disposition: attachment`) over the same `q?`/`tag_id?` filters; columns `full_name,email,phone,source,created_at,tags,applications_count`. Export is owner-scoped, never includes resume bytes/links.

### 4.5 Tags & Notes (Phase 2; spec'd now)

`GET /api/tags` (owner's tags, α-order) · `POST /api/tags` `{ name, color? }` (409 on dup) · `DELETE /api/tags/:id` (cascades `applicant_tags`) · `PUT /api/applicants/:id/tags` `{ tag_ids: uuid[] }` (replace set; journals `tag_added`/`tag_removed`) · `POST /api/notes` `{ applicant_id, application_id?, body }` (journals `note_added`) · `DELETE /api/notes/:id`.

### 4.6 Integrations

Base rule: credentials are **write-only** — no GET endpoint ever returns `credentials_encrypted` or decrypted material. Responses expose `{ type, status, config (non-secret subset), created_at }`.

| Route                                       | Purpose                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/integrations/google/start`       | Returns Google OAuth URL (Drive scope, offline) with signed `state`                                                                                                                       |
| `GET /api/integrations/google/callback`     | Exchanges code → stores encrypted refresh token → redirects to settings                                                                                                                   |
| `POST /api/integrations/google/root-folder` | Body `{ folder_id: string } \| { create_named: string }` — sets `config.root_folder_id`                                                                                                   |
| `GET /api/integrations/google/folders`      | Lists owner's Drive folders for the picker (server-side call)                                                                                                                             |
| `POST /api/integrations/telegram`           | Body `{ bot_token, chat_id?, detect? }`; validates via `getMe`, auto-detects chat_id via `getUpdates` when `detect: true`, verifies with a real test `sendMessage`, then stores encrypted |
| `POST /api/integrations/telegram/test`      | Sends test message; 200 `{ ok: true }` or 502 `INTEGRATION_ERROR`                                                                                                                         |

### 4.7b Users

| Route                            | Body → Response                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PATCH /api/users/me`            | `{ notify_telegram?, notify_applicant_email? }` → updated profile row (docs/02 §9 toggles; strict schema) |
| `POST /api/integrations/ai`      | Body `{ api_key }` (Phase 3); verifies with trivial Gemini call; stores encrypted                         |
| `DELETE /api/integrations/:type` | `disconnected` status + delete credentials. Idempotent.                                                   |
| `GET /api/integrations`          | List active integrations (safe shape above)                                                               |

### 4.7 AI (Phase 3; spec'd now)

| Route                                   | Body → Response                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ai/parse-resume`             | `{ resume_id }` → `{ parsed: ParsedResume, cached: boolean }` (extracts + caches `resumes.parsed_text`, caches `ai_parsed`)                    |
| `POST /api/ai/summarize-applicant`      | `{ applicant_id, force? }` → `{ summary, strengths: string[3], cached: boolean }` (cache `applicants.ai_summary`)                              |
| `POST /api/ai/generate/job-description` | `{ title, notes? }` → `{ description }` (Markdown, no cache)                                                                                   |
| `POST /api/ai/generate/social-post`     | `{ job_id, tone?, platform? }` → `{ post }` (≤ 280 chars + link line, no cache)                                                                |
| `POST /api/integrations/ai`             | `{ api_key }` → verifies with a 1-token `generateContent` ping → 200 integration safe-shape (`config.capabilities`, `config.key_hint` = last4) |

All: 401/403 as usual + `402 ai_not_configured` semantics = 400 `AI_NOT_CONFIGURED` if user has no AI integration; 502 `INTEGRATION_ERROR` on Gemini failure (429 → "AI is busy — try again in a minute"; invalid/revoked key also flips the integration row to `error` and surfaces the settings banner). Prompts/schema: `10 §Prompts`.

### 4.8 Misc

| Route                                 | Purpose                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                     | **PUBLIC** `{ ok, db, version }` (no internals beyond build sha)                                                                                                                                                                                                                                  |
| `GET /api/applications/:id/resume`    | Streams resume bytes to **owner** (auth-checked) — the only resume bytes egress                                                                                                                                                                                                                   |
| `GET /api/timeline` (Phase 2)         | Global activity feed; `applicant_id?`, `application_id?`, `type?`, cursor pagination (`created_at_id`), `{ data, next_cursor }`                                                                                                                                                                   |
| `GET /api/cron/reconcile` (Phase 2)   | Vercel cron; `Authorization: Bearer $CRON_SECRET` (401 otherwise, 404 when `CRON_SECRET` unset). Samples recent `resumes.uploaded` (≤200), HEADs Drive `files.get(fields=id)`; missing → `resume_failed` event + integration `error` (07 §7, G4). Returns `{ checked, missing, owners_notified }` |
| `POST /api/webhooks/resend` (Phase 2) | Resend svix webhook; HMAC-SHA256 verify via `RESEND_WEBHOOK_SECRET` (404 when unset, 401 on bad signature). `email.bounced`/`email.complained` → `email_failed` event matched by `payload.message_id` (09 §Bounces)                                                                               |

### 4.9 Organizations (Phase 4; normative — rules in 11)

Every route below is owner-auth'd (401 without session). Scoping: "scope" = the caller's **current workspace** (11 §1 — cookie `hl_org` → `default_organization_id` → personal). Capabilities enforced via `lib/authz.ts` (403) — matrix in 11 §2.

| Route                                    | Purpose                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/orgs`                          | My memberships → `{ data: [{ org: Organization, role }] }` (excludes soft-deleted)                                                                                                                                                                                                              |
| `POST /api/orgs`                         | Create org `{ name }` (2–120) → 201 `{ org, role: 'owner' }`; slug = nanoid(10). Invite acceptance is a single normative path (token link) — creating an org never auto-seats anyone                                                                                                            |
| `GET /api/orgs/current`                  | Resolved workspace → `{ workspace: { kind: 'personal' } \| { kind: 'org', org, role } }`                                                                                                                                                                                                        |
| `POST /api/orgs/current`                 | Switch: `{ organization_id: uuid \| null }` (null = personal; membership validated or 404). Sets cookie + persists `users.default_organization_id`. 200 → resolved workspace                                                                                                                    |
| `GET /api/orgs/:id`                      | Detail (member-only, else 404): org + `members[]` (user id, name, email, role) + `pending_invites[]` for `members.manage` + `usage: { active_jobs, seats, applications }` + `limits` (from plan)                                                                                                |
| `PATCH /api/orgs/:id`                    | `{ name? }` (owner/admin) · `{ brand?: { logo_url?, primary_color?, email_from_name? } }` strictly org **owner** + plan ≠ free (402 `PLAN_LIMIT`) · `{ restore: true }` reserved — restore has its own route below                                                                              |
| `DELETE /api/orgs/:id`                   | Soft-delete (org owner only) → 204. Members lose access instantly (RLS inert via `current_org_role`); 7-day grace (11 §7)                                                                                                                                                                       |
| `POST /api/orgs/:id/restore`             | Clear `deleted_at` inside grace window (org owner only) → 200 org                                                                                                                                                                                                                               |
| `POST /api/orgs/:id/transfer`            | `{ user_id }` (must be a member) — org owner only. Sets `organizations.owner_id`, target role→owner, previous owner role→admin. 200 org                                                                                                                                                         |
| `GET /api/orgs/:id/invites`              | Pending invites `[{ id, email, role, expires_at, created_at }]` (`members.manage` else 403)                                                                                                                                                                                                     |
| `POST /api/orgs/:id/invites`             | `{ email, role: 'admin'\|'member' }` → creates invite (7d expiry, SHA-256-hashed 24-char token; replaced on re-invite of same email) + sends `org_invite` email (best-effort, degrade per 03 §6). Seats check → 402. 201 → `{ invite: {…}, join_url }` (join_url shown once for manual sharing) |
| `DELETE /api/orgs/:id/invites/:inviteId` | Revoke pending invite → 204                                                                                                                                                                                                                                                                     |
| `PATCH /api/orgs/:id/members/:userId`    | `{ role: 'admin'\|'member' }` — `members.manage`; cannot touch org owner; admin cannot promote to admin? **Normative: admin CAN promote member→admin** (11 §2 "not owner" is the only restriction); demoting another admin = owner only                                                         |
| `DELETE /api/orgs/:id/members/:userId`   | Remove member — `members.manage`, never the org owner. Self-leave allowed for any non-owner. If the removed user's `default_organization_id` = this org it is reset to null server-side                                                                                                         |
| `GET /api/invites/:token`                | Peek for the accept screen (auth required): `{ org_name, role, inviter_name, expires_at, email }`; 410 `INVITE_EXPIRED` otherwise                                                                                                                                                               |
| `POST /api/invites/:token/accept`        | Accepts (auth required): email on invite must match session email (403 `FORBIDDEN` otherwise); seats re-checked (402); idempotent for same user (200 already-member). 200/201 → `{ org, role }`; caller's default org set when unset                                                            |

Response shapes use DB column names (§1). `Organization` = `{ id, name, slug, owner_id, brand, plan, created_at }` — `deleted_at` never exposed.

### 4.10 Smart Screening (Phase 5; normative — rules in 17)

All routes owner-auth'd + workspace-scoped like §4.9 (404 when the job is outside the current scope). Screening config is **PRIVATE** — rules never leave these routes (17 §3.4/§10).

| Route                                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/jobs/:id/screening-config`     | `{ questions: Question[] }` (full definition incl. rules) for the builder                                                                                                                                                                                                                                                                                                                  |
| `PUT /api/jobs/:id/screening-config`     | Replace questionnaire `{ questions: Question[] }` (zod; ≤20 questions; ids nanoid-6 server-side; `jobs.write`) → 200 full config. Editing history does NOT rewrite verdicts — see re-run                                                                                                                                                                                                   |
| `POST /api/jobs/:id/screening-recompute` | Re-run the deterministic engine for the job's non-terminal applications (17 §4.4; synchronous — pure engine, DB-bound; only changed verdicts are updated + journaled) → 200 `{ recomputed: n, changed: n }`                                                                                                                                                                                |
| `GET /api/applications/:id/answers`      | Answers for an application → `{ data: [{ question_id, label, type, answer }] }` (joined against current config for labels; answer-only fallback for deleted questions) + `screening_status`. Detail embed also carries `answers` + `screening_status` from Phase 5 (§4.3 GET amendment)                                                                                                    |
| `POST /api/ai/applicant-profile`         | Build/refresh the parse-v2 resume profile `{ applicant_id }` → `{ profile: ResumeProfile, cached, updated_at }`. Cache rule (17 §6): reused (`cached: true`, NO model call) when `source_resume_id` = latest uploaded resume AND `prompt_version` current; rebuilt otherwise. No key → 400 `AI_NOT_CONFIGURED`; unreadable file (`.doc`/scanned) → §4.7-style graceful `INTEGRATION_ERROR` |
| `POST /api/ai/screenings`                | Create session `{ job_id, pool, instruction (3–2000), max_results 1–100 }` → 201 session. Pool snapshotted at create (17 §7). No active/running session per job rule: 409 `CONFLICT` if a `queued`/`processing` session exists for the job. No Gemini key → 400 `AI_NOT_CONFIGURED`                                                                                                        |
| `GET /api/ai/screenings?job_id=`         | Session list for a job (append-only history) `[{ id, pool, max_results, instruction, status, pool_size, processed, failed, engine, created_at, started_at, completed_at, created_by_name }]`                                                                                                                                                                                               |
| `GET /api/ai/screenings/:id`             | Session detail + `results` when completed (grouped by category, ordered rank; per-row `reasons/evidence/uncertainties`)                                                                                                                                                                                                                                                                    |
| `POST /api/ai/screenings/:id/retry`      | Re-queue `failed` rows (17 §9.3) → 202 `{ requeued: n }`. No-op 200 when none failed                                                                                                                                                                                                                                                                                                       |
| `POST /api/ai/screenings/:id/cancel`     | Cancel `queued`/`processing` session → 200 (completed rows are retained)                                                                                                                                                                                                                                                                                                                   |
| `GET /api/cron/screening-worker`         | Bearer-gated worker tick (17 §9): advances ≤1 running-session slice per call (≤8 candidates interactive, or batch poll/drain); also invoked opportunistically by the screening dashboard (advance-on-view). 404 without `CRON_SECRET`                                                                                                                                                      |

No new error codes beyond the existing §2 set (`AI_NOT_CONFIGURED`, `CONFLICT`, `VALIDATION_ERROR`, `PLAN_LIMIT` already cover the failure surface).

**Org integrations (Phase 4 clarification to §4.6):** integration connect endpoints accept org context = current workspace. `POST /api/integrations/google/start?org=:id` carries the org id through signed state into the callback (requires `integrations.manage`). `POST /api/integrations/telegram` accepts `{ bot_token, chat_id?, detect? }` (personal bot) or `{ shared: true, chat_id }` (org shared bot — only when `TELEGRAM_SHARED_BOT_TOKEN` is configured and workspace is an org; credentials stay null, token resolves from env — 11 §3). `POST /api/integrations/ai` connects an org BYOK key when the workspace is an org. `DELETE /api/integrations/:type` disconnects the **workspace-scoped** row. `GET /api/integrations` returns personal rows + (when switched into an org) org rows flagged by the presence of `config`/`organization` context: shape stays `{ type, status, config, created_at }` per §4.6 — org context signaled via a top-level `workspace` echo.

## 5. TypeScript Contracts (excerpt — normative shapes)

```ts
// schemas shared client/server (zod)
export const FormFieldRule = z.enum(['required', 'optional', 'hidden'])
export const FormConfig = z
  .object({
    phone: FormFieldRule.default('optional'),
    resume: FormFieldRule.default('required'),
    cover_note: FormFieldRule.default('hidden'),
  })
  .strict()

export const ApplyInput = z
  .object({
    full_name: z.string().trim().min(2).max(200),
    email: z.string().email().max(320),
    phone: z.string().trim().max(40).optional(),
    cover_note: z.string().max(4000).optional(),
    source: z.string().max(60).default('direct'),
    website: z.literal('').optional(), // honeypot
  })
  .strict()
```

File rules: `pdf|doc|docx` (magic bytes `%PDF`, `D0CF11E0` CFB for doc, `PK\x03\x04` zip for docx), ≤ 10 485 760 bytes.

## 6. Versioning & Evolution

Phase 1–3: unversioned `/api/*` (internal UI consumer only). Breaking changes → update UI atomically in same PR (13 §Contract Tests). **Phase 4 decision (logged 2026-08-08):** the API remains unversioned and internal-only; a public versioned API (`/api/v1`) is deferred to the backlog (15) and ships only when a public API is committed to. Phase 4 adds org routes under §4.9 with no versioning implications.
