# 15 — Project Roadmap

> Last updated 2026-08-07. Sequencing is normative; **estimates are planning roughs** for a single experienced dev + AI assistance, in focused dev-weeks (DW), not calendar promises. Re-estimate at each phase exit and log here + CHANGELOG.

## Phase 0 — Foundation ✅ Complete 2026-08-07 _(est ≈ 1.0–1.5 → ~1 DW actual)_

**Goal:** deployable skeleton with real auth + real DB.

**Scope**

- Repo: Next.js 15 + TS strict + Tailwind + ESLint/Prettier per 14; `lib/env.ts`; CI (`ci.yml`)
- Supabase local + hosted staging/prod projects; migrations `0001`–`0004` (04 §7) incl. RLS
- Google login via Supabase Auth; `handle_new_user`; auth shell (`/login`, middleware-protected `/dashboard/*`)
- App shell per 06 §4 (bottom tabs / rail), design tokens + core `ui/` components (Button, Input, Card, Toast, EmptyState, Banner)
- `GET /api/health`, logger, error wrapper (`handleRoute`), Sentry env-gate

**Deliverable:** a logged-in user sees an empty dashboard on Vercel.
**Exit criteria:** E1 E2-prereq Playwright green · CI gates live · 12 §Checklist "staging" column complete.

## Phase 1 — Personal Hiring Tool ✅ Code complete 2026-08-08 _(est ≈ 2.0–3.0 → ~1.5 DW actual)_

**Goal:** the full hiring loop works for one owner (MVP). _The launchable product._

Remaining before public launch: staging verification with real services (Supabase apply flow, Drive, Telegram bot, Resend domain). All offline code gates green (CHANGELOG).

**Scope** (doc refs: 02, 05, 07, 08, 09)

- Jobs CRUD + slug links; public `/apply/[slug]` (RSC, budget 06 §8) + `POST /api/apply/:slug` (multipart, magic-byte validation, rate limit, idempotent upsert, honeypot)
- Google Drive integration: OAuth, root-folder picker, upload, streaming view route, failure degradation
- Inbox + application detail + status transitions + timeline (core subset)
- Telegram integration (bot token flow, templates, test message)
- Email system: Resend, `application_received`, registry, simulated local transport
- Settings: profile toggles + integrations screens
- Tests: E1–E8 green; unit coverage gate on

**Deliverable:** owner creates link on phone → shares → receives applicant in Drive + Telegram ping → applicant gets email → owner triages in Inbox.
**Exit criteria:** 12 §go-live gate 100% · Lighthouse budgets pass (blocking from here) · G1/G2 measured on 3 beta owners · CHANGELOG v0.1.0.

## Phase 2 — Talent CRM _(≈ 2.0–3.0 DW)_ ✅ code-complete 2026-08-08

**Goal:** living with 100s of applicants stays effortless.

**Scope** (02 §6–7, 04 §3.7–3.9, 05 §4.3–4.5)

- Pipeline board per job (drag/long-press, optimistic), bulk actions ✅
- Tags + notes + unified timeline + global activity feed (`/api/timeline`) ✅
- Talent pool: applicants list/profile, trigram search + filters (job/status/tag/date/q) ✅
- Archive/unarchive; application delete with Drive-file note (07 §7); CSV export of applicants ✅
- `/api/cron/reconcile` (G4) + bounce webhook `POST /api/webhooks/resend` ✅
- CSP header hardening (03 §7); public PWA manifest ✅

**Shipped:** `/dashboard/pipeline/[jobId]` board (HTML5 drag desktop, long-press/⋯ Move-to sheet mobile, TanStack optimistic + rollback toast; columns = pipeline chain + rejected, archived off-board), bulk actions bar (set_status/add_tag/archive, ≤100 ids) on board + inbox explorer; tags (inline create, color chips, replace-set), notes (composer + delete), people explorer (search/tag filter/CSV export), applicants profile (contact + phone editor, tags, applications, notes, timeline), application-detail tags/notes/delete with Drive-kept confirm; APIs per 05 §4.3–4.5/§4.8; migration `0005_phase2_indexes.sql` (trigram + notes index + `application_deleted` enum); svix-verified Resend bounce webhook matched by `payload.message_id`; reconcile cron (Vercel `crons` 03:00 UTC); prod-only hardened CSP; `manifest.webmanifest` + SVG icons.

**Deliverable:** pipeline + talent-pool parity with spreadsheet workflows recruiters actually use.
**Exit criteria:** perf budgets hold with 10k seeded applications (seed script shipped; run pending a live local Supabase — sandbox has no DB) · E5/E6 extended (T5 = E6 board-level rollback ✅, e2e green: 86 unit + 24 always-on e2e + 13 DB-gated specs) · v0.2.0.

## Phase 3 — AI (BYOK) _(≈ 1.5–2.0 DW)_ ✅ code-complete 2026-08-08

**Goal:** accelerate review and drafting without ever being required (G5).

**Scope** (10 in full): AI settings + key verify/encrypt; `AIProvider` + Gemini impl; `parsed_text` extraction pipeline (pdf/docx); four features (parse, summarize, JD draft, social post) with caches; prompt versioning + fixtures; degradation states. ✅ all shipped

**Shipped:** Settings → AI BYOK card (paste → 1-token verify → AES-256-GCM store, masked `…last4`, error-state banner, instant revoke); `lib/ai` seam (types ⇒ capabilities-declared `AIProvider`, plain-REST Gemini `gemini-2.0-flash` with key-in-header + 30s timeout + injectable transport, versioned prompts `lib/ai/prompts.ts` carrying the three non-negotiables, tolerant JSON extraction); `parsed_text` pipeline (pdf → `pdf-parse` lib-path, docx → `mammoth`, `.doc` graceful-null, 50k-char cap, cached on resumes); parse-resume (responseSchema + zod `ParsedResumeSchema` with heal-on-rails caps → 1 stricter retry → graceful fail, cached `ai_parsed`); summarize-applicant (≤120 words + 3 strengths enforced post-model, `applicants.ai_summary` JSON cache + force-regenerate, `ai_summary_generated` journal w/ prompt_version); JD draft assist (job form, human-in-the-loop editable draft) + social post generator (tone/platform, ≤280 + link line, job detail). Degradation per 10 §6: 400 `AI_NOT_CONFIGURED`, 429 exact copy "AI is busy — try again in a minute", key-rejected flips integration `error` + settings banner, malformed → retry → friendly inline fail; AI slot hidden on application detail when unconfigured (06 §4), settings/jobs show disabled explainers. PII disclosure in Settings (10 §7).

**Deliverable:** owner pastes Gemini key → summaries on demand, JD drafting in job creation. ✅
**Exit criteria:** all Phase 1–2 suites still green with AI disabled (86→109 unit + 24→29 always-on e2e incl. A1–A4 degradation matrix gated, injection fixture asserted neutralised across all prompt builders) ✅ · real-key happy path pending a live Gemini key (env-dependent by design) · v0.3.0.

## Phase 4 — SaaS _(≈ 4.0–6.0 DW → ~1.0 DW actual)_ ✅ code-complete 2026-08-08

**Goal:** teams & agencies onboard themselves.

**Scope** (11 in full): org onboarding + switcher; invites; roles & `authz`; org integrations + branding on apply page/emails; plans & limits (manual billing); `0006` activation migration + backfill; cross-tenant security suite (11 §7); shared Telegram bot option; org-level Drive (shared Google account). ✅ all shipped

**Shipped:** workspace resolution (cookie `hl_org` → `default_organization_id` → personal) + `requireWorkspace` guard threaded through every service/route (child tables via `!inner` embeds; scope mismatch = 404); top-bar switcher + Settings workspace card (create/switch/rename, plan usage grid, members+invites, branding, danger-zone soft-delete/restore); invites (hashed 7-day single-use tokens, peek page, atomic accept RPC with email-match/seat-cap/idempotency, best-effort invite email, workspace auto-switch after accept); authz matrix (`lib/authz.ts` pure data + org-owner-only overrides: branding/transfer/delete; owner untouchable; admin demotion owner-only); plans free 3/1/500 · pro 25/3/10k · team 100/25/50k with 402 `PLAN_LIMIT` at create/reopen/invite + mirrored cap inside the RPC; org-first integrations with labelled fallback (`{row, level}`) — Drive OAuth carries org through state, Telegram shared-bot mode (`TELEGRAM_SHARED_BOT_TOKEN`), AI org BYOK pool, workspace-scoped disconnect; apply-page branding (pro/team logo+color header, else "via HireLink" pill) + org `email_from_name`; `POST /api/jobs/:id/move` with exclusively-attached applicant re-scoping; org-first apply dedupe (org job + personal row → re-scope into the shared pool); soft-delete 7-day grace + `GET /api/cron/org-purge` re-homing rows to creators (no data loss); **0006 additive migration** (invites DDL, soft-delete col, default-org FK, org indexes, security-definer helpers, additive org RLS on all 10 shared tables, guarded shell-org backfill — zero data movement) + `scripts/backfill-orgs.mjs` (`--dry-run`/`--yes`).

**Deliverable:** an agency runs 3 recruiters under one branded org. ✅
**Exit criteria:** cross-tenant suite written (X1–X10, DB-gated — green-run pending live Supabase, same posture as seed-perf; gates: **184 unit + 48 always-on e2e** incl. 19-route org 401 matrix) · 0006 rehearsal on a staging dump pending (needs hosted Supabase — docs/12 checklist) · ✅ **v1.0.0**.

## Phase 5 — Smart Screening _(est ≈ 2.0–3.0 DW)_ 🚧 in progress

**Goal:** when a job receives 100s–1,000s of applications, screening stops being manual. User-requested feature (2026-08-09); normative spec **docs/17**.

**Scope** (17 in full)

- Per-job **screening questionnaire** (11 question types; mandatory/preferred/informational classification; rules private, sanitized public projection) ✅ spec'd
- **Deterministic verdict** at apply time (`qualified` / `does_not_meet_mandatory` / `review_required`; ambiguity → review, never silent rejection; nobody deleted) ✅ spec'd
- **Resume profiles** (parse v2 cache via the existing Gemini adapter) ✅ spec'd
- **AI Screening Sessions**: natural-language instruction on a snapshotted pool, top-N as an _upper bound_, per-candidate category + reasons + evidence + uncertainties (`INSUFFICIENT_EVIDENCE` vocabulary), async processing (DB state machine + cron/advance worker, Gemini Batch accelerator), partial-failure retry, append-only history ✅ spec'd
- Stages: 5.0 docs ✅ → 5.1 questionnaire+engine → 5.2 profiles → 5.3 sessions → 5.4 async → 5.5 results/Drive → 5.6 QA+scale gate

**Deliverable:** a recruiter screens a 500-application job: questionnaire splits the pool deterministically, then one AI session ("healthcare + SQL + Power BI, up to 50") returns an evidence-backed shortlist — recruiter decides everything.
**Exit criteria:** all Phase 1–4 suites still green (AI off) · engine 100 % branch-covered · S1–S10 green on live Supabase incl. 500-candidate run (scale gate — no "scale-ready" claim without it, 17 §16) · CHANGELOG v1.2.0.

## Cross-Phase Backlog (not scheduled — pull in order of pain)

WhatsApp Business channel · interview scheduling + calendar · `interview_invitation`/`rejection` emails (09 catalogue) · CSV/LinkedIn import · public versioned API (/api/v1) · Stripe · multi-language UI · S3/R2 storage option (07 §9) · QStash/Inngest background jobs (03 §9).

## Risk Register (top of mind each phase)

| Risk                                                | Phase | Mitigation                                                            |
| --------------------------------------------------- | ----- | --------------------------------------------------------------------- |
| Google OAuth app verification drag for `drive.file` | 1     | start verification at Phase 0; non-sensitive scope keeps review short |
| Telegram BotFather UX too nerdy for owners          | 1     | guided setup + chat-ID autodetect; Phase 4 shared-bot fallback        |
| Upstash/Vercel cold-start latency on apply POST     | 1     | budget enforced in CI (06 §8); keep apply bundle tiny                 |
| AI key UX confusion ("why do I need one?")          | 3     | docs-in-UI + one-click link to create a free Gemini key               |
| 0006 backfill mistakes                              | 4     | idempotent script + staging rehearsal + snapshot before run           |
