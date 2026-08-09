# 12 — Deployment Guide

> Last updated 2026-08-07. Normative for env setup, CI/CD, and go-live. Environments overview: `03 §8`.

## 1. Topology

| Piece             | Provider                                               | Notes                                                     |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Web app (Next.js) | **Vercel**                                             | Git-connected; `main`→prod, PRs→preview                   |
| Database + Auth   | **Supabase** (hosted)                                  | One project per env: `dev` (local CLI), `staging`, `prod` |
| Email             | Resend                                                 | Domain verified per env sender                            |
| OAuth             | Google Cloud Console                                   | One OAuth client; per-env redirect URIs                   |
| Rate limit (opt)  | Upstash Redis                                          | Only prod/preview                                         |
| Monitoring        | Vercel logs + Analytics · Sentry (optional, env-gated) | `SENTRY_DSN` absent = disabled                            |

## 2. Environment Variable Matrix (normative — validated by `lib/env.ts`)

| Var                                                          | dev                                                                 | preview             | prod                | Notes                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_APP_URL`                                        | http://localhost:3000                                               | `$VERCEL_URL`       | https://app.…       | used for links in emails/Telegram                                                                                                                                                                                                                                                                                                                                  |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅                                                                  | ✅                  | ✅                  | per-env project                                                                                                                                                                                                                                                                                                                                                    |
| `SUPABASE_SERVICE_ROLE_KEY`                                  | ✅                                                                  | ✅                  | ✅                  | **server only**                                                                                                                                                                                                                                                                                                                                                    |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                  | ⚠️ optional at boot                                                 | ⚠️ optional at boot | ⚠️ optional at boot | Drive OAuth (07). `lib/env.ts` treats these as optional so the app degrades gracefully without them (`features.googleDriveOAuth`) — but Drive is the product's core storage loop, so a **prod deploy without them is a real functional gap, not just a missing nicety**. Set them in every environment; do not rely on the boot check passing as proof Drive works |
| `ENCRYPTION_SECRET`                                          | ✅                                                                  | ✅                  | ✅                  | 64-hex (32 bytes); rotate = re-encrypt task                                                                                                                                                                                                                                                                                                                        |
| `RESEND_API_KEY`                                             | test key                                                            | test key            | live                | absent → simulated transport (09)                                                                                                                                                                                                                                                                                                                                  |
| `EMAIL_FROM`                                                 | dev@localhost                                                       | staging@…           | notifications@…     | verified domain                                                                                                                                                                                                                                                                                                                                                    |
| `UPSTASH_REDIS_REST_URL/TOKEN`                               | ✖️                                                                  | ✅                  | ✅                  | absent → rate-limit disabled (05 §3)                                                                                                                                                                                                                                                                                                                               |
| `CRON_SECRET`                                                | ✖️                                                                  | ✅                  | ✅                  | guards `/api/cron/*` (Phase 2, + `/api/cron/org-purge` Phase 4, + `/api/cron/screening-worker` Phase 5)                                                                                                                                                                                                                                                            |
| `SENTRY_DSN`                                                 | ✖️                                                                  | optional            | recommended         | —                                                                                                                                                                                                                                                                                                                                                                  |
| `TELEGRAM_SHARED_BOT_TOKEN`                                  | ✖️                                                                  | optional            | optional            | Phase 4 shared org bot (11 §3); absent → option hidden                                                                                                                                                                                                                                                                                                             |
| Never in env                                                 | Telegram bot tokens (per-owner), Drive refresh tokens, user AI keys | →                   | →                   | live in DB encrypted (D3), **not** env                                                                                                                                                                                                                                                                                                                             |

Boot behaviour: missing required var → fail fast with named var in error; never run half-configured.

## 3. Local Development

```bash
# Prereqs: Node 20, pnpm, Supabase CLI, Docker (for local supabase)
supabase start                       # local Postgres + Auth at :54321
pnpm install && cp .env.example .env.local   # fill values; scripts/check-env validates
pnpm db:reset                        # supabase db reset --local (wipes + re-applies supabase/migrations/* + seed.sql)
pnpm dev                             # http://localhost:3000
```

`pnpm db:reset` (`supabase db reset --local`) wipes and re-applies every migration from scratch — use it for first-time setup or whenever you want a clean slate. `pnpm db:migrate` (`supabase db push --local`) applies only pending migrations without wiping — use it day-to-day after adding a new migration file.

Google login locally: add `http://localhost:3000/api/auth/callback`-equivalent Supabase redirect + `http://localhost:54321` auth callback in Supabase Auth settings (CLI `config.toml`). `supabase/seed.sql` is intentionally a no-op (see its header comment) — it does not create demo data automatically. Sign in with Google first (creates your `public.users` row via the `handle_new_user` trigger), then optionally run `scripts/seed-perf.mjs` or `scripts/seed-screening.mjs` against your own owner id for bulk sample data.

## 4. Database Migrations Workflow

1. Write migration file `supabase/migrations/0NNN_name.sql` (04 §7) — **append-only history**.
2. `supabase db reset --local` must pass; write up-to-date seed if schema changed.
3. PR CI runs migrations against a throwaway staging DB (13 §CI).
4. Merge to `main` → GitHub Action applies to **staging**, smoke test passes, then applies to **prod** (`supabase db push`) with a pre-run `pg_dump` snapshot stored in the workflow artifacts.
5. Rollback: forward-fix migration preferred; catastrophic → restore snapshot, log incident in CHANGELOG.

## 5. CI/CD (GitHub Actions)

| Workflow                  | Trigger                                   | Steps                                                                                                                                     |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                  | every PR                                  | lint → typecheck → unit (Vitest) → build → migrations job (`supabase db reset` against a throwaway local Postgres) → Playwright e2e       |
| `migrate.yml`             | merge to `main` (migration files changed) | pg_dump snapshot → staging migrate → smoke (`GET /api/health`) → pg_dump snapshot → prod migrate — secrets-gated, no-ops until configured |
| `weekly-integrations.yml` | cron Mon 06:00 UTC + manual dispatch      | real Drive/Telegram/Resend contract tests (07 §8, 08 §6, 09 §6) — secrets-gated, each provider's suite self-skips independently           |

**Secrets required** (repo Settings → Secrets → Actions; every workflow above degrades gracefully — jobs/suites self-skip rather than fail — until its secrets exist):

| Secret                                                                      | Used by                   | Purpose                                               |
| --------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN`                                                     | `migrate.yml`             | Supabase CLI auth for `link`/`db push`                |
| `STAGING_PROJECT_REF` / `PROD_PROJECT_REF`                                  | `migrate.yml`             | Supabase project refs to link against                 |
| `STAGING_DB_URL` / `PROD_DB_URL`                                            | `migrate.yml`             | Postgres connection strings, `pg_dump` snapshots      |
| `STAGING_APP_URL`                                                           | `migrate.yml`             | deployed staging URL for the post-migrate smoke check |
| `TELEGRAM_TEST_BOT_TOKEN` / `TELEGRAM_TEST_CHAT_ID`                         | `weekly-integrations.yml` | real bot → private test chat (08 §6)                  |
| `DRIVE_TEST_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` / `_FOLDER_ID` | `weekly-integrations.yml` | real Drive box, quarantined test folder (07 §8)       |
| `RESEND_TEST_API_KEY` (a `re_test_…` key) / `RESEND_TEST_TO`                | `weekly-integrations.yml` | Resend test-mode send (09 §6)                         |

Vercel: preview deployments on PRs (env `preview`), production on `main` (env `prod`). Preview URLs are allow-listed for OAuth callbacks via wildcard domain support (Google Console: add `*.vercel.app` only if feasible — else dedicate staging URL; document the final choice in this file at setup time).

## 6. Production Checklist (go-live gate)

- [ ] All migrations applied; `pg_dump` snapshot verified restorable (restore drill once)
- [ ] Env matrix complete on Vercel prod; `lib/env.ts` boot check green
- [ ] Google OAuth consent screen published; prod redirect URIs: auth (`https://<proj>.supabase.co/auth/v1/callback` in Google + app URL in Supabase) and Drive callback in Cloud Console
- [ ] Supabase Auth: Google provider enabled with prod creds; Site URL + redirect allow-list set
- [ ] Resend domain verified (SPF/DKIM/DMARC); `EMAIL_FROM` live
- [ ] RLS spot-check with anon key against every table (must return zero rows)
- [ ] Rate limiting on (`UPSTASH_*` present); 429 verified on apply endpoint
- [ ] Error tracking live (Sentry or logs drain); alert on `5xx > 1%/5min`
- [ ] Sentry/logging excludes PII (parsed resume text) — verified
- [ ] 06 §8 perf budgets measured on prod (Lighthouse mobile on `/apply/demo` + `/dashboard`)
- [ ] Backup plan noted: Supabase daily backups + weekly manual `pg_dump` to founder's Drive
- [ ] Runbook (this file + CHANGELOG) updated; `PROJECT_MEMORY.md` refreshed

**Phase 4 (v1.0 SaaS) additions:**

- [ ] `0006` rehearsed on a staging dump of prod shapes (apply → `scripts/backfill-orgs.mjs --dry-run` → count diff) with snapshot taken first (11 §6.4, 15 §Risks)
- [ ] Cross-tenant suite X1–X10 green against staging (`E2E_WITH_DB=1`, two-tenant fixtures — 13 §3)
- [ ] Personal-org backfill spot-check: 3 pre-existing users have "{Name}'s workspace" shells, dashboards unchanged (`organization_id` still null on their rows)
- [ ] Soft-delete drill: delete a staging org → members locked out instantly → `POST /api/orgs/:id/restore` → access back → `/api/cron/org-purge` on an expired one re-homes rows to creators
- [ ] Cron schedule confirmed in Vercel: `reconcile` 03:00 + `org-purge` 04:00 UTC

**Phase 5 (Smart Screening) additions:**

- [ ] `0007`–`0009` applied; RLS spot-check passes for `application_answers`, `applicant_profiles`, `ai_screening_sessions`, `ai_screening_results` (anon = zero rows)
- [ ] **Screening worker cadence:** `*/1 * * * *` cron on `/api/cron/screening-worker` (paid Vercel plan — 1-min crons). Hobby plan: worker relies on advance-on-view (17 §9.1) — acceptable default, note in runbook; never claim live-processing SLAs there
- [ ] S-suite green on staging with a **real Gemini key** incl. S10 (500-candidate pool via `scripts/seed-screening.mjs`) — the scale gate (13 Phase-5)
- [ ] Gemini free-tier reality check re-read from the official docs before launch (17 §15: interactive ≈ 15 RPM / 250 RPD at last verification — Google has cut these without notice; copy uses "typically minutes–about an hour" for big pools)

## 7. Incident & Rollback Notes

- Bad deploy → Vercel "Promote previous deployment"; note in CHANGELOG with cause.
- Bad migration → §4.5. Data incidents touching resumes: check Drive directly (files live there), reconcile per 07 §7.
- Secrets leak → rotate `ENCRYPTION_SECRET` with re-encrypt script (all integrations briefly `error` → users reconnect), rotate Google/Resend keys, force Supabase token revoke. Incident template in 13 §Release QA.

## 8. Cost Ladder (rough, honest)

| Stage                                         | Monthly                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Phase 0–2 (solo dev + few users)              | $0–25 (free tiers: Vercel Hobby, Supabase Free, Resend Free, Upstash Free) |
| Phase 3–4 early SaaS (~100 orgs)              | ~$70–150 (Vercel Pro 20 + Supabase Pro 25 + Resend 20 + misc)              |
| AI cost: $0 platform-side forever (BYOK, D7). |
