# 13 — Testing Strategy

> Last updated 2026-08-07. Normative. Goal: **every PR mergeable with confidence from CI alone**, and Phase 1 launch quality without a QA hire.

## 1. Test Pyramid

| Layer                   | Tooling                               | Scope                                                                               | Target                                                        |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Unit**                | Vitest + Testing Library              | services, providers (mocked), crypto, schemas, template/escapers, hooks, components | ≥ 60% line coverage on `src/lib` + `src/features/*/server.ts` |
| **Integration**         | Vitest against Supabase local (CLI)   | route handlers → real Postgres + RLS; fake providers                                | every endpoint in 05 has ≥ 1 happy + 1 auth/validation test   |
| **Contract**            | Vitest + recorded fixtures            | Gemini prompts (10 §8), Resend payload shape, Telegram API shape                    | prompt/provider fixtures re-recorded per change               |
| **E2E**                 | Playwright (Chromium mobile viewport) | critical journeys §3                                                                | green on every merge to `main`                                |
| **Real-provider smoke** | weekly CI job                         | Drive/Telegram/Resend real calls (07 §8, 08 §6, 09 §6)                              | failure pages the maintainer, does not block merges           |

Anti-goals: no testing-library coverage for trivial markup, no brittle snapshot walls, no sleeping arbitrary `waitForTimeout` in E2E (use expect-polling).

## 2. What Must Always Be Tested (per feature PR)

1. zod schemas: happy + one boundary + one malformed input.
2. RLS: integration test proves tenant/owner A cannot read owner B rows for every touched table.
3. Failure degradation: for any provider call added, one test asserting flow continues on provider throw (03 §6).
4. Timeline side-effects: status changes/notes/uploads write the right `timeline_events` rows.
5. New endpoints: request validation 400 + 401/403/404 matrix (05 §2).

## 3. Critical E2E Journeys (Playwright, mocked providers except where noted)

| ID  | Journey                                                                      | Asserts                                                                                                                  |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| E1  | Owner signs in (dev auth bypass fixture)                                     | lands on dashboard, profile row exists                                                                                   |
| E2  | Create job → copy link                                                       | slug URL produced; public page renders title                                                                             |
| E3  | Applicant applies (mobile viewport, resume attached, fake SMTP + fake Drive) | success screen; DB has applicant+application+resume rows; `telegram_sent`/`email_sent` simulated events                  |
| E4  | Duplicate apply                                                              | second submission → `already_applied: true`, no dup rows                                                                 |
| E5  | Drive disconnected at apply time                                             | application still 201s; `resume_failed` event; dashboard banner visible                                                  |
| E6  | Pipeline move                                                                | PATCH → status updated + `status_changed` event; optimistic UI rollback on forced 500                                    |
| E7  | Closed job link                                                              | 410-styled page, no form, POST → `JOB_CLOSED`                                                                            |
| E8  | Rate limit on apply                                                          | 6th rapid POST → 429 JSON shape (05 §2) (covered by unit-level shape tests offline; full 429 path runs with Upstash env) |

**Environment gate:** E2–E8 require a seeded Supabase fixture. Run with `E2E_WITH_DB=1` + `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY` / `E2E_DEV_USER_EMAIL` (magic-link fixture: `e2e/helpers/auth.ts`). Without the gate they self-skip — the always-on CI suite (health, login, shell-protection) needs no services.

**Phase 2 additions:**

| Suite                          | Gate      | Covers                                                                                                                                                                                                                                      |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/phase2-api.spec.ts`       | always-on | 401-envelope matrix for every Phase 2 owner route (12 routes), public `manifest.webmanifest`, cron/webhook feature-gate (401/404)                                                                                                           |
| `e2e/talent-crm.spec.ts` T1–T7 | DB-gated  | tag CRUD (+409), tag-attach + search/tag filter + `tag_added` feed, notes + `note_added`, bulk `set_status` (T4), E6 board rollback on forced 500 (T5), filtered CSV export (T6), application delete + journaled `application_deleted` (T7) |
| `scripts/seed-perf.mjs`        | manual    | 10k-application seed (`SEED_OWNER_ID`, `--count`, `--clean`) for the perf-budget walk (15 Phase 2 exit); local-only guard, `SEED_FORCE=1` to override                                                                                       |

**Phase 3 additions (AI, docs/10 §8):**

| Suite                              | Gate      | Covers                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/ai.test.ts`                 | always-on | VCR-style recorded-response fixtures: request shape, fake-transport provider (key-rejected→integrationBroken, 429→retryable, multi-part join), tolerant JSON parse, `ParsedResume` contract (validate/heal/reject paths), **injection fixture neutralised** (wrapper + directives asserted on ALL prompt builders), cache round-trip, ≤120-word truncation, input schemas, extraction normalisation |
| `e2e/ai-api.spec.ts`               | always-on | 401-envelope matrix for the 4 AI features + key connect                                                                                                                                                                                                                                                                                                                                             |
| `e2e/ai-degradation.spec.ts` A1–A4 | DB-gated  | every AI route 400 `AI_NOT_CONFIGURED` without a key (G5), settings connect card visible while degraded, invalid key rejected at connect and not stored, application detail hides the AI slot per 06 §4                                                                                                                                                                                             |

**Phase 4 additions (SaaS, docs/11):**

| Suite                             | Gate      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/authz.test.ts`             | always-on | full capability matrix × role grid (owner/admin/member/personal/none), org-owner override rules (transfer/delete/branding), unknown role → deny                                                                                                                                                                                                                                                                                           |
| `tests/orgs.test.ts`              | always-on | `PLAN_LIMITS` boundaries + `assertWithinPlan` (402 shape), workspace-resolution precedence (cookie → default → personal, dead membership skipped), scope-filter helper, invite token/hash + expiry, zod schemas (org/invite/brand/hex color), migration 0006 SQL sanity (tables/policies/fns/backfill guard present, idempotent)                                                                                                          |
| `e2e/orgs-api.spec.ts`            | always-on | 401-envelope matrix for every Phase 4 org/invite route                                                                                                                                                                                                                                                                                                                                                                                    |
| `e2e/cross-tenant.spec.ts` X1–X10 | DB-gated  | P0 tenant isolation (11 §7): tenant B gets `[]`/404 on every list/detail route of tenant A (jobs, applications + resume stream, applicants + export.csv, tags, notes, timeline, org detail); org member positive read inside shared org; `members` capability 403s (member PATCH role, member DELETE member, admin PATCH owner); PLAN_LIMIT 402 on 4th active job (free org); invite round-trip (create → peek → accept → member visible) |

**Phase 5 additions (Smart Screening, docs/17):**

| Suite                            | Gate      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/screening-engine.test.ts` | always-on | **100 % branch coverage of the pure engine** (17 §4 safety rail): every type×operator, clear-fail → DNMC, pass-all → qualified, missing/ambiguous → review_required (never reject), no-mandatory-questions → null, education-level ladder, CTC bounds, keyword matching, unknown-answer-type tolerance                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/screening.test.ts`        | always-on | questionnaire zod schemas (≤20 questions, option caps, id shape), **sanitizer strips classification+rule** from the public projection, answers payload validation (unknown-id drop / missing-required field errors), `ScreeningResultSchema` heal/reject + INSUFFICIENT_EVIDENCE vocabulary, prompt builders (injection + non-negotiables asserted), session-create guards (409 concurrent, pool snapshot), migration 0007 SQL sanity                                                                                                                                                                                                                                                                        |
| `e2e/screening-api.spec.ts`      | always-on | 401-envelope matrix for the §4.10 routes; public apply payload contains `questions` sans `rule`/`classification` fields (Q7 leak check)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `e2e/screening.spec.ts` S1–S10   | DB-gated  | S1 questionnaire round-trip (build → candidate answers → verdict on application) · S2 DNMC candidate still visible everywhere · S3 ambiguous answer → review_required (not rejected) · S4 full session small pool (fake transport? no — live key) with reasons/evidence present · S5 max-N honored as upper bound (23 strong returned when asked 50) · S6 partial failure → counts honest + retry succeeded rows untouched · S7 resume injection neutralised in result text · S8 re-run session safety (history append-only) · S9 concurrent session 409 · S10 500-candidate pool via `scripts/seed-screening.mjs` — the scale gate that must pass on live Supabase before "scale-ready" is claimed (17 §16) |

## 4. Test Data & Fakes

- **Factories** (`tests/factories.ts`): `makeJob()`, `makeApplicant()`… with sensible defaults; never reuse literal UUIDs across tests.
- **Fake providers** (`tests/fakes/`): in-memory `StorageProvider`, `NotificationService` spy (records calls, can be armed to throw), `AIProvider` stub. Fakes implement the real interfaces — this is why 03 mandates interfaces.
- **DB isolation:** integration suites run per-worker schemas reset via `supabase db reset` template + truncated tables between files; RLS tests use two distinct auth users.
- **Auth in E2E:** seeded dev user + Supabase magic-link token endpoint called directly from the fixture (no Google UI in tests).

## 5. CI Gates (12 §5 mapping)

| Gate                                                                                                            | Blocks merge                                                 |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `tsc --noEmit`                                                                                                  | ✅                                                           |
| `eslint` + `prettier --check`                                                                                   | ✅                                                           |
| unit + integration (+ coverage report)                                                                          | ✅                                                           |
| Playwright E1–E8                                                                                                | ✅ (on `main` and release branches; PRs run E3/E4/E6 subset) |
| Real-provider smoke + restore drill                                                                             | ❌ weekly, alert-only                                        |
| Perf budget check (06 §8): Lighthouse CI on `/apply/[demo-slug]` — warn-only until Phase 1 exit, then blocking. |

## 6. Manual QA / Release Checklist (pre-tag)

- [ ] Fresh-phone walkthrough: create job → share via WhatsApp → apply from 3G-throttled phone → owner alerted (Telegram) → triage to `shortlisted`
- [ ] Visual pass Chrome/Safari/Firefox + iOS Safari + Android Chrome at 360px
- [ ] a11y spot: keyboard-only inbox triage + VoiceOver on apply form (06 §6)
- [ ] Email visual: `application_received` in Gmail + Apple Mail
- [ ] Drive hygiene: files land in right folders; revoke access → banner path (07 §8)
- [ ] Failure drill: kill Supabase locally mid-apply → 503 page sane; restore (07 §7 drill quarterly)
- [ ] CHANGELOG updated; version tagged; `PROJECT_MEMORY.md` state section refreshed

## 7. Bug & Incident Policy

- P0 data leak/cross-tenant → halt deploys, fix forward, incident note in CHANGELOG (12 §7 template).
- Every bug fix PR includes the failing test first (red→green in commits).
- Flaky test = P2 bug; quarantined tests expire (auto-delete after 14 days if not fixed).
