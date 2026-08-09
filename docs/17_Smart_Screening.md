# 17 — Smart Screening (Phase 5)

> Last updated 2026-08-09. Normative for Phase 5. Additive to v1.0.0 — nothing in Phase 0–4 is replaced (D1–D8 stand; this feature leans on D2 Drive, D3 encryption, D4 degrade-gracefully, D7/G5 AI-optional).
>
> **Purpose.** When a job receives 100s–1,000s of applications, manual resume screening collapses. Smart Screening does it in two stages: (1) **deterministic questionnaire screening** of explicit candidate answers, (2) **optional AI screening** that ranks the surviving pool against the recruiter's natural-language instruction plus everything already stored about the job. **The recruiter always decides** — AI prioritizes, never hires or rejects.

## 1. Goals & Non-Goals

**Goals**

- Configurable per-job questionnaires; mandatory rules deterministically split the pool (`qualified` / `does_not_meet_mandatory` / `review_required`) without deleting anyone.
- Persistent **AI Screening Sessions** (history never overwritten) that rank a chosen pool top-N by instruction with reasons, evidence, and uncertainties.
- Asynchronous processing of large pools (500+) that survives page abandonment; partial failures are isolated and retryable.
- Reuse: `lib/ai` Gemini adapter + BYOK (10 §1), Drive storage (07), workspace/RLS engine (11), Phase 3 resume caches.

**Non-Goals (Phase 5)**

- Auto-reject/auto-hire automation, candidate-facing score disclosure, interview scheduling, WhatsApp channel, batch resume ingestion (CSV import stays backlog).
- Physical Drive reorganization by screening status (§13 decides: metadata in DB, files unmoved).

## 2. Concepts & Data Model (DDL in 04 §3.12)

| Concept                  | Home                                        | Notes                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Questionnaire definition | `jobs.screening_config jsonb` (**PRIVATE**) | Questions + options + classification + mandatory rules. Never shipped to candidates (§3.4).                                                                                            |
| Answers                  | `application_answers`                       | One row per `(application_id, question_id)`; answer payload as `jsonb`.                                                                                                                |
| Deterministic verdict    | `applications.screening_status text`        | `null` (no mandatory questions configured) / `qualified` / `does_not_meet_mandatory` / `review_required`. Orthogonal to `applications.status` (pipeline). AI may never write it (§14). |
| Resume profile           | `applicant_profiles`                        | Parse-v2 structured profile (§6), cached per applicant, sourced from latest resume.                                                                                                    |
| AI Screening Session     | `ai_screening_sessions`                     | Job, creator, instruction, pool, provider/model/prompt-version, lifecycle status, counts, timestamps, optional engine ref.                                                             |
| AI Screening Result      | `ai_screening_results`                      | One row per candidate in a session: rank, category, reasons/evidence/uncertainties, per-row status + error (retry unit).                                                               |

## 3. Questionnaire

### 3.1 Question types

`yes_no` · `single_choice` · `multiple_choice` · `dropdown` · `text` · `number` · `education` (level picklist) · `experience_years` (numeric) · `location` (text w/ datalist-less free input) · `current_ctc` / `expected_ctc` (annual, integer, currency per market — stored as raw number) · `relocate` (yes/no).

Each question: `{ id (nanoid-6), label (≤140 chars), required: bool, type, options? (≤12 for choice types, ≤60 chars each), classification: 'mandatory'|'preferred'|'informational', rule? }`.

### 3.2 Classification semantics

- **Mandatory** — carries a `rule` (§4 operators). Contributes to the deterministic verdict.
- **Preferred** — no rule; informs AI screening and is shown to recruiters.
- **Informational** — stored and shown; excluded from screening entirely.

### 3.3 Candidate-facing UX

Rendered inside the existing apply form (06 §4 pattern: stacked, ≤8 questions recommended, soft cap 20 enforced by schema). Mobile-first 360px; native inputs (radio group, checkboxes, select, text/number inputs). No scoring hints, no "this is required to qualify" copy — candidates see plain questions with `*` for required.

### 3.4 Rule privacy

The apply page and `GET /api/jobs/:slug/public` receive a **sanitized projection**: `{ id, label, required, type, options }` only — `classification` and `rule` are stripped server-side. Screening config APIs are owner-scoped; a candidate can never learn the qualifying answers (e2e-asserted, 13 Phase-5 Q7).

## 4. Deterministic Screening Engine (`lib`/`features/screening/engine.ts` — pure, no DB)

### 4.1 Rule operators (per type)

| Type                                                   | Operators                                                                  |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| yes_no / relocate                                      | `eq` true                                                                  | false |
| single_choice / dropdown                               | `in` set · `not_in` set                                                    |
| multiple_choice                                        | `includes_all` · `includes_any` · `includes_none`                          |
| number / experience_years / current_ctc / expected_ctc | `min` · `max` (either or both)                                             |
| text / location                                        | `contains_any` (case-insensitive keywords) · `not_empty`                   |
| education                                              | `min_level` over `high_school < diploma < bachelors < masters < doctorate` |

### 4.2 Verdict algorithm (`evaluateScreening(config, answers) → verdict + per-question detail`)

1. `null` when no mandatory questions exist (nothing to screen — feature effectively off for the job).
2. Evaluate every mandatory rule in order. Rule with a **missing/unanswerable/ambiguous** answer → marks that rule `review_required` (never a rejection — §4.3).
3. Any rule **clearly failed** → `does_not_meet_mandatory`. Else any rule `review_required` → `review_required`. Else `qualified`.
4. Ambiguity examples: free-text that the operator can't judge neutrally, type mismatch, empty required answer, unparsable number. Rejection requires a _clear_ answer outside the rule.

### 4.3 Safety rail

**The engine can only disqualify on explicit, parseable answers.** This is terminal behavior, unit-tested to 100% branch coverage (13 Phase-5).

### 4.4 Re-evaluation

Verdicts are computed at submission. Editing the questionnaire does not rewrite history; the job builder offers a one-click **"Re-run screening for existing applications"** that recomputes verdicts for non-hired/rejected applications and journals `questionnaire_screened` events for changed verdicts only. The recompute runs **synchronously** in the request (the engine is a pure function; the work is DB-bound and batched at 500 rows per read, ≤ 10 k applications per job) — it deliberately does NOT use the §9 AI worker, which exists for quota-sensitive Gemini calls, not deterministic rule evaluation.

## 5. Apply-Flow Integration (05 §4.2 amendment)

- `POST /api/apply/:slug` accepts an additional multipart field `answers` (JSON string, ≤8 kB) shaped `{ question_id: value }`; zod-validated against the job's sanitized question set (unknown → ignore + warn-log; missing required → VALIDATION_ERROR with per-question field errors).
- Order committed: existing idempotency/dedupe (03 §5) runs first; answers are persisted (replace-on-duplicate-apply = keep first) and the verdict computed **in the same request** (pure engine, no AI call — deterministic path is free and instant).
- `screening_status` is written on the application; a `questionnaire_screened` timeline event journals `{ verdict, failed_rule_ids?, review_rule_ids? }`.
- Candidates without a resume-parse path are unaffected; with AI absent nothing changes (§11).
- Existing validations (rate limit, honeypot, magic bytes, form_config enforcement) are untouched.

## 6. Resume Profiles (parse v2)

- New capability on the **same** adapter: `profile_extract` (prompt `profile_extract.v1`, schema `ResumeProfileSchema`) extracting: education[], employers[] (name, title, months, industry?), skills[]/tools[], responsibilities_summary, total_experience_years, location, current_ctc/expected_ctc (only when explicitly stated), notice_period, projects[] (≤5).
- Extraction source = `resumes.parsed_text` (Phase 3 pipeline reused; `.doc` → graceful null as today).
- Cache: `applicant_profiles` keyed by applicant, `source_resume_id` recorded; refreshed only when a **newer** resume arrives or the prompt version changes. Never re-parsed needlessly; original file untouched in Drive.
- Profiles are recruiter-visible (applicant profile page gains a "Parsed profile" card, collapsed by default **when a profile exists** — the empty state starts open so the Build action is visible) and are the primary AI-screening input alongside questionnaire answers. Build/refresh route: `POST /api/ai/applicant-profile` (05 §4.10).

## 7. AI Screening Sessions

`POST /api/ai/screenings { job_id, pool, instruction, max_results (1–100) }`:

- **Pool** = `qualified` (default) | `review_required` | `qualified_review` | `all_non_archived` (exact DB tokens). Pool membership is snapshotted into `ai_screening_results` rows (`pending[]`) at create — later applications do not leak into a running session, and the pool size is frozen in the session record.
- **Instruction** ≤ 2,000 chars; job context is assembled server-side (title, description, screening questions incl. preferred answers, org brand name) — recruiters never repeat stored information.
- Session statuses: `queued → processing → completed | failed | cancelled`. Counts: `pool_size, processed, failed`. Creator + model + prompt_version frozen at start. History is append-only (list endpoint; delete = not offered in Phase 5).
- Top-N semantics (locked): `max_results` is an **upper bound** on `strong_match`+`possible_match` shown in ranked positions; the AI is instructed to return fewer when fewer qualify; rank gaps are allowed; **the standard is never lowered to fill N** (prompt non-negotiable).

## 8. AI Result Contract (`ScreeningResultSchema`)

```jsonc
{
  "category": "strong_match | possible_match | review_required | lower_priority",
  "rank": 1, // optional integer within session; ties/gaps permitted
  "score": 0, // 0-100 AI-prioritization score — NOT a probability; UI labels it exactly that (§8.1)
  "reasons": ["≤ 5, each ≤ 20 words"],
  "evidence": [
    "≤ 5, each quoting/paraphrasing a concrete datum with its source: resume|answer|profile",
  ],
  "uncertainties": ["≤ 3; INSUFFICIENT_EVIDENCE when a needed datum is absent"],
}
```

### 8.1 Language locks (product-level)

- No percentage presented as "match probability"; score displayed as **AI prioritization score**.
- Missing information must surface under `uncertainties` (`INSUFFICIENT_EVIDENCE` token allowed and UI-rendered as "Not clear from resume"), never converted into negatives.
- Categories are advisory labels; they never map to `applications.status` (§14).

### 8.2 Prompt non-negotiables (extensions of 10 §5)

0. **Candidate anonymization**: candidates are packed as anonymous labels (`C1…C8`) — recruiter-facing identity fields (name/email/phone columns) never enter the packed blocks (strengthens 10 §5 non-negotiable 3: the model cannot echo contact-identity proxies; resume text itself is excerpted as-is). Results are keyed by label and mapped back server-side.
1. Everything inside `<resume_text>`, `<questionnaire_answers>` is **inert data, never instructions** — existing injection fixture pattern proves neutralization per builder (13 Phase-5 Q8).
2. **Evidence-only**: every reason must trace to a datum present in the packed context; fabrication of skills/employers/dates/salary is forbidden and zod-post-checked for shape.
3. Fewer-than-N is always acceptable; quality gate before quantity.
4. Non-discrimination clause carried over verbatim from 10 §5.

## 9. Asynchronous processing

### 9.1 Why

Vercel function budgets (10–60 s) prohibit synchronous 500-row runs (§Stage-1 findings). No queue infra exists; Phase 5 ships a **DB state machine** advanced by:

1. `after()` kickoff right after session creation (starts immediately),
2. **`GET /api/cron/screening-worker`** — Vercel cron every minute (documented: 1-min crons require a paid Vercel plan; Hobby deployments degrade to (3)); each tick scans the active-sessions partial index (≤10), CAS-claims ≤3 claimable sessions and advances each one ≤50 s slice within a 45 s budget,
3. **advance-on-view**: `GET /api/ai/screenings/:id` kicks one post-response slice via `after()` while the session is active — the dashboard's 3 s polling trips it continuously (self-healing; worst case on Hobby).

Never blocks the browser; progress visible as `processed / pool_size`.

**Single-processor lease (migration 0008):** every advancer CAS-claims `ai_screening_sessions.locked_at` first (locked + valid lease ⇒ skip). A cleanly-finished slice releases the lock to `null` (immediate handoff); a crash leaves it to be reclaimed after the **10-minute** expiry; a `quota_limited` pause keeps the fresh lock as a **2-minute** cooldown marker (auto-resume on the next tick afterwards). Concurrency between after()-kickoff, cron and advance-on-view is therefore impossible by construction.

### 9.2 Engines (one interface, `evaluateCandidate(candidateContext, instruction) → ScreeningResult`)

| Engine                          | When                                              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interactive chunk** (default) | Pools of any size; always available               | Worker takes ≤8 candidates/call within a time slice; paced to stay under ~10 RPM headroom for free-tier keys; 429 → exponential backoff, session pauses with `quota_limited` notice and auto-resumes on next tick                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Gemini Batch** (accelerator)  | pending pool ≥ 50 **and** key's model supports it | One batch job per session, one prompt per candidate (`metadata.key` = result row id — correlation never trusts the echoed label). Inline submissions only (15 MB guard with slack under the 20 MB limit); oversized or 400-class "unsupported" → **falls back to the interactive engine seamlessly** (file-mode JSONL deliberately deferred). 24 h SLO, ~50 % cost, does **not** consume interactive RPD. Worker polls per `batchStats` (counters mirrored live); on SUCCEEDED it drains keyed responses, and a wholesale FAILED/EXPIRED/CANCELLED batch leaves every row pending for the interactive fallback — candidates are never harmed |

Both verified against the July 2026 Batch API docs at build time; per-candidate failures (`failed` rows) never fail the session (§20 of the feature brief): `retry` re-queues only failed rows.

### 9.3 Failure policy

Row-level statuses: `pending → ok | failed(error)`. Timeouts/network/parse → `failed`; invalid key → session `failed` with actionable banner (reuse AI key-rejected degradation, 10 §6); completed sessions with `failed>0` show **Retry failed** (new attempt rows-replaced, history of the session retained).

**Retry semantics (05 §4.10, shipped 5.4):** retry re-queues ONLY `failed` rows back to `pending` and revives the terminal session (`processing`, `locked_at` cleared, engine provenance reset to `interactive` so the §9.2 batch gate re-decides on the REAL pending volume — 3 failed rows of a 500-pool never re-batch). A key-broken session whose rows are still `pending` is **resumed** by the same endpoint after the key is re-connected (`resumed` count in the 202 response); with nothing left to redo it answers an honest 200 no-op. **Cancel** stops `queued`/`processing`/`quota_limited` sessions (two-tap confirm on mobile), cancels a live Gemini Batch remotely best-effort (D4 — the local row never blocks on the provider), retains completed rows, and leaves unscreened rows `pending` for a later retry.

## 10. Security & Privacy

- New tables: RLS enabled, org-scoped policies mirroring 04 §6 Phase-4 set (`current_org_role` on the parent job's scope); service-role client allowed only in `/api/apply/**`, `/api/jobs/:slug/public`, cron worker (ESLint zones unchanged beyond those).
- Answers are **candidate PII** — treated like resumes: owner/member reads via RLS, never public, never logged (payload logger redaction list gains `answers`).
- `screening_config` (rules) never leaves owner surfaces (§3.4); the public apply payload is enum-shaped so accidental field bleed fails zod.
- AI inputs are untrusted: packed blocks + guardrails (§8.2); keys remain server-side (10 §1).
- Original resumes stay in the owner's Drive (files never moved — §13); viewing them remains owner-authed streaming only.

## 11. Degradation & AI-optional matrix

| State               | Questionnaire                 | Deterministic verdict     | Profiles                               | AI sessions                                                 |
| ------------------- | ----------------------------- | ------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| No Gemini key       | ✅ works                      | ✅ works (it's pure code) | skipped silently                       | create → `400 AI_NOT_CONFIGURED`, existing copy (10 §6)     |
| Key revoked mid-run | ✅                            | ✅                        | stops                                  | session `failed`, banner, retry after re-connect            |
| 429 / quota         | ✅                            | ✅                        | —                                      | session pauses `quota_limited`, auto-resume                 |
| Timeout/network     | ✅                            | ✅                        | row `failed`, retryable                | row `failed`, retryable                                     |
| Drive disconnected  | ✅ answers + verdict recorded | ✅                        | resumes marked failed as today (07 §7) | rows without resume text screen on answers+application only |

## 12. UI/UX surfaces (extending 06 §4 — no redesign)

- **Job edit** — "Screening questionnaire" section: add question (type picker), options editor, classification picker; mandatory reveals the rule control matched to type. Preview toggle "Candidate view".
- **Job detail** — new **Screening** tab beside Pipeline: pool counters (`Qualified 500 · Review 12 · DNMC 488`), sessions list (status chips, counts, created-by), "New screening" form (pool selector with live counts, instruction textarea, max-N), results view grouped strong/possible/review/lower with expandable reasons-evidence-uncertainties, links into application detail, live progress (`127 / 500 processed`), **Retry failed** button.
- **Apply page** — questions render between contact fields and resume upload; required gets the existing red `*`; budget note in 06 §8 (measured bump documented).
- **Application detail** — "Questionnaire" card (answers, verdict badge) — verdict never editable by AI; recruiter changes pipeline status exactly as before (§14).
- **Applicants profile** — collapsed "Parsed profile" card (§6).

## 13. Drive organization (decision)

**Files are never moved or duplicated by screening.** `Master/<Job>/Applications/…` stays as-is (07); verdicts/ranks live in the DB. Optional artifact: on session completion the worker writes one immutable JSON summary (`screening-<date>-<shortid>.json`: pool counts, result rows incl. reasons/evidence) into `Master/<Job>/AI Screenings/` (created lazily via `ensureFolder`, cached on `ai_screening_sessions.summary_folder_id` — later sessions of the same job reuse the first cached sibling id — and the file id lands on `summary_file_id`). **Write-once:** a retried session does NOT rewrite the artifact (immutability) — the dashboard remains the live source and links the file when present. Drive disconnected/unauthorized → artifact skipped silently; failure to write never fails the session (D4).

## 14. Human-in-the-loop guarantees (locked)

1. AI writes only `ai_screening_*` rows. `applications.status`, notes, tags, messaging stay 100% recruiter-driven (existing tools = override).
2. Deterministic `screening_status` is computed in code only; AI cannot alter it.
3. Every result links back to: original resume (streamed), answers, application — one tap away.
4. Session history is read-only append — auditable who-instructed-what-when.

## 15. Limits & quotas (verify at build time — logged in docs/12 ops)

Verified 2026-08-09 against ai.google.dev (2.5-Flash free AI-Studio key): interactive ≈ **15 RPM / 250 RPD**; Batch API = separate quota, 24 h SLO, 50 % cost, no RPD consumption. Product copy must never promise wall-clock times for large pools on free keys ("typically minutes–about an hour" wording). Prompt budget per candidate: profile + answers + job context + instruction ≈ ≤2k tokens input, ≤512 output — comfortably inside 250k TPM even at full interactive pace.

## 16. Testing & acceptance (13 Phase-5 governs)

Engine 100 % branch coverage; S1–S10 DB-gated journeys incl. injection neutralization, re-run safety, partial-failure retry, rule privacy leak check, and a 500-candidate pool exercise via `scripts/seed-screening.mjs` (`e2e/screening.spec.ts` — S1–S3 + S9 + S10a run with the DB fixture alone; S4–S8 + S10b additionally need `E2E_WITH_AI=1` + `E2E_AI_API_KEY` + the app's `ENCRYPTION_SECRET`). **Exit gate: the 500-candidate run is demonstrated on a live Supabase (docs/12 checklist) before the feature is called scale-ready** (feature brief §21/§26) — offline gates green meanwhile, same posture as seed-perf.

## 17. Troubleshooting (ops runbook)

| Symptom                                                | Cause                                                          | Fix (safe order)                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session `processing` forever, progress frozen          | advancer crashed / Hobby truncations; lease held               | Nothing — the 10-min lease expires and the next tick (cron/advance-on-view) resumes it. If it persists, open the session once (advance-on-view ticks). |
| `quota paused` for a long time                         | Gemini 429 / free-tier RPD exhausted (17 §15)                  | Auto-resumes after the 2-min cooldown. If RPM-bound, wait for the minute; if RPD-bound, resume after the daily reset or switch to a paid key.          |
| Session `failed` with the key banner                   | Gemini key rejected (rotated/revoked) (17 §9.3)                | Re-connect in Settings → AI, then **Retry** the session — pending rows resume, failed rows re-queue; completed rows are untouched.                     |
| `Retry` returns 200 with `requeued: 0, resumed: 0`     | nothing left to redo (every row already has a verdict/failure) | Not an error — the honest no-op. Start a new session to re-screen the pool.                                                                            |
| 400 `AI_NOT_CONFIGURED` on create                      | no active Gemini key in the current workspace                  | Settings → AI. Questionnaire screening keeps working meanwhile (17 §11).                                                                               |
| "Summary in Drive" link missing on a completed session | Drive not connected / write hiccup (D4)                        | Optional artifact, §13 — reconnect Drive and future sessions will write it; write-once means past sessions are not backfilled.                         |
| Batch badge never appears on a big run                 | pool < 50 pending or Batch create fell back (model/key/bytes)  | Expected — the interactive engine screens the same candidates either way; check logs for `staying interactive`.                                        |
| Cron 404/401 on `/api/cron/screening-worker`           | `CRON_SECRET` unset (404) or wrong bearer (401)                | Set the secret (docs/12 §4), redeploy; on Hobby rely on advance-on-view (documented cadence row).                                                      |
| Results groups look "too strict" (small shortlist)     | the standard is never lowered to fill top-N (§8.1)             | Review **beyond top-N** + review_required groups; humans always decide (§14).                                                                          |

## Decisions log (Phase 5)

1. Verdicts stored on a **separate column**, not the pipeline enum — screening and disposition are orthogonal lifecycles.
2. Rules kept in `jobs.screening_config` — never in public `form_config` (§3.4).
3. `.doc` resumes remain graceful-null for profiles (existing extractor limitation accepted).
4. Answers replaced on duplicate-apply = **first write wins** (idempotency semantics unchanged).
5. Session results keyed by **application id at snapshot**; a re-apply later does not retro-join a completed session.
6. Hobby-tier Vercel without 1-min crons degrades to advance-on-view (documented in 12), never a blocker.
