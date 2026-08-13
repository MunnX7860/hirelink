# 07 — Google Drive Integration (Phase 1 storage)

> Last updated 2026-08-07. Normative. Implements `StorageProvider` (`03 §4`) with Google Drive. Security principles: Master PRD D2/D3.

## 1. Why User-Owned Drive

Resumes live in the **owner's own Google Drive**, organised automatically by job. The platform stores only references (`storage_file_id`), never files. Benefits: user owns data (principle 4), zero storage cost, natural per-user quota sharding, and deletion/disconnect never orphans files in _our_ infra.

## 2. OAuth Setup (separate from login — D1)

Login (Supabase Auth Google) and Drive use **two different OAuth grants**. Drive consent is requested only when the owner connects Drive (incremental auth), keeping login friction minimal.

| Setting | Value                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope   | `https://www.googleapis.com/auth/drive.file` — **only**. No full-drive access; we can see/create just files we created or that the user picked via our flow. |
| Flow    | Authorization code, `access_type=offline`, `prompt=consent` (guarantees refresh token)                                                                       |
| Client  | Same Google Cloud OAuth client as login is allowed; redirect URI dedicated: `{APP_URL}/api/integrations/google/callback`                                     |
| State   | HMAC-signed `{ owner_id, nonce, ts }`, 10-min TTL, one-time use                                                                                              |
| Library | `googleapis` Node client (Node runtime route, `03 §2`)                                                                                                       |

**Google Cloud Console requirements:** OAuth consent screen with `drive.file` listed; app verification filed when moving to production (scope is non-sensitive-tier but verification recommended); redirect URIs for local (`http://localhost:3000/api/integrations/google/callback`), preview, prod (12 §Env Matrix).

## 3. Token Lifecycle

1. Callback exchanges `code` → `{ access_token, refresh_token, expiry_date }`.
2. **Storage:** payload JSON → AES-256-GCM (`lib/crypto.ts`, `ENCRYPTION_SECRET`) → `integrations.credentials_encrypted`, `type='google_drive'`, `config.root_folder_id=null`. Format: `v1.<b64 iv>.<b64 tag>.<b64 ciphertext>`.
3. **Use:** server decrypts → constructs drive client with refresh token → `googleapis` auto-refreshes the access token; on refresh, the new access/expiry are re-encrypted back to the row (refresh tokens are long-lived but Google may rotate them — always persist returned refresh tokens).
4. **Failure:** `invalid_grant` (revoked/expired) → set `status='error'`, surface banner (02 §8.1); uploads degrade per 03 §6. Owner reconnects → new grant replaces the row (unique partial index in 04 §3.10 keeps one active Drive row per owner).
5. **Disconnect:** delete credentials, `status='disconnected'`. Drive files remain (they are the user's).

## 4. Folder Layout

```
{User-chosen Root Folder}/                    ← integrations.config.root_folder_id
└── {sanitized Job Title}—{job.id first-8}/    e.g. "Barista—4f2a91c3"
    ├── {sanitized Applicant Name}—{safe original filename}.pdf   ← no mandatory questionnaire: flat
    ├── Qualified/            ← screening_status = 'qualified'
    ├── Not Qualified/        ← screening_status = 'does_not_meet_mandatory'
    ├── Needs Review/         ← screening_status = 'review_required' (ambiguous/incomplete answer — NOT a rejection)
    └── AI Screenings/        ← Phase 5 (17 §13): one immutable summary JSON per completed screening session, screening-<date>-<shortid>.json
```

- Root chosen by owner via picker (`GET /api/integrations/google/folders`) or auto-created as **"HireLink"** (`POST .../root-folder { create_named }`).
- Job folder created directly under root (no intermediate "Jobs/" folder) lazily on first resume (`ensureJobFolder`), cached on `jobs.drive_folder_id`.
- **Verdict subfolders** (docs/17 §4–§5): the apply route evaluates the job's deterministic questionnaire verdict (`evaluateScreening`, pure, no DB) before uploading. A job with ≥1 mandatory question routes the resume into `Qualified/`, `Not Qualified/`, or `Needs Review/` under the job folder; a job with no mandatory questions (verdict is always `null`) uploads flat, matching the pre-questionnaire layout. This only reflects the verdict at the moment of apply — a later "Re-run screening" recompute updates `applications.screening_status` in the DB but does NOT move already-uploaded files between folders.
- `AI Screenings/` created lazily on first completed screening session (`ensureFolder`), cached on `ai_screening_sessions.summary_folder_id` (sibling sessions of the same job reuse the first cached id; the uploaded file id lands on `summary_file_id`). Screening NEVER moves or duplicates resumes.
- Sanitisation: strip `/\:*?"<>|`, collapse spaces on dots, max 80 chars. Names are cosmetic — IDs are the identity.
- **Resume filenames carry no applicant id** (`{Name}—{original filename}.ext`) — readability was chosen over guaranteed uniqueness. Drive permits duplicate names within a folder, so two _different_ applicants sharing both a name and an original filename yield two identically-named files in the job folder. Accepted: `resumes.storage_file_id` is the identity and the authed streaming route (§6) resolves by id, never by name.
- `ensureChildFolder` (the private helper behind both `ensureJobFolder` and `ensureFolder`) does a `files.list` lookup by exact name+parent before creating — Drive folder names are non-unique, so a create-only implementation would mint a fresh duplicate on every call that isn't backed by a DB-cached id (this was a real bug: every new job independently created its own "Jobs/" parent before this list-then-create fix landed).

## 5. Upload Flow (called from `03 §5`)

```
ensureJobFolder(job)                          // cached folder id, or find-or-create directly under root
verdict = evaluateScreening(questions, answers).status   // pure, computed before upload — null if no mandatory questions
folderId = verdict ? ensureFolder(VERDICT_LABEL[verdict], jobFolderId) : jobFolderId
ensureFolder('AI Screenings', jobFolderId)    // Phase 5 screening summaries (17 §13) — always a sibling, not under a verdict folder
uploadFile({ folderId, filename, mime, data })
  → files.create({ name, parents: [folderId] }, media, supportsAllDrives: false)
  → return fileId
insert resumes row { storage_file_id: fileId, upload_status: 'uploaded' }
timeline: resume_uploaded { file_id, size }
```

- Idempotency: upload step guarded by "does this application already have an `uploaded` resume row?" — retry loops don't create duplicates in Drive.
- Timeouts: 30s per upload attempt; 1 retry with backoff 5s; second failure → `resume_failed` timeline + `upload_status='failed'`, owner Telegram'd (03 §6). **Application itself never fails because of Drive.**
- Quotas/errors mapping: `403 rateLimitExceeded|userRateLimitExceeded` → retryable; `404 root folder missing` → integration `error` + banner; `invalid_grant` → §3.4.

## 6. File Access (viewing resumes) — D2 hard rule

**Files are never shared publicly** — no `anyone with link` permissions, no direct Drive URLs exposed to the browser.

- Owner clicks **View resume** → `GET /api/applications/:id/resume` (owner auth check) → server streams bytes from `files.get(alt=media)` with correct `Content-Type` + `Content-Disposition: inline; filename="<safe>"`. Browser opens in new tab.
- Bandwidth: ≤10 MB files — streaming inline is fine; no caching of bytes server-side.

## 7. Deletion & Reconciliation

- Application deletion (Phase 2): DB row cascades; Drive file **remains** (owner may need it for compliance). A dashboard note says files are kept in Drive; `DELETE /api/integrations/google/files/:fileId` (owner-initiated, Phase 2) calls `files.delete`.
- Account deletion: credentials deleted ⇒ platform permanently loses access; files stay in user's Drive. Documented in-app.
- Phase 2 `/api/cron/reconcile`: for a sample of recent `resumes.uploaded` rows, HEAD `files.get(fields=id)`; missing files → integration warning + `resume_failed` event (G4 metric).

## 8. Testing Notes (per 13)

- Unit: crypto roundtrip, sanitiser, retry mapping (mocks).
- Contract: fake `StorageProvider` in-memory impl used across the test suite for any test touching uploads.
- Integration (CI weekly, not per-PR): real Drive box account, env-gated (`DRIVE_TEST_*`), uploads to a quarantined folder then deletes.
- Manual QA checklist item: revoke access at myaccount.google.com → verify banner + degraded apply flow still accepts applications.

## 9. Non-Goals / Future

- No browsing/editing arbitrary Drive content, no Team Drives (Phase 4 shared drives via org-owned Google account — 11).
- S3/R2 `StorageProvider` impl is Phase 4 config (per-org storage choice), not a Phase 1 requirement.
