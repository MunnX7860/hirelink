# HireLink

**The simplest mobile-first hiring and talent CRM for businesses hiring through social media.**
Create a hiring link → share it anywhere → applicants flow in with resumes organised in your own Google Drive, Telegram alerts for you, confirmation emails for them.

> Working title. Phases: **0 Foundation → 1 Personal Hiring Tool → 2 Talent CRM → 3 BYOK AI → 4 SaaS** (see `docs/15_Project_Roadmap.md`).

## Status

✅ **Phase 0 — Foundation** (2026-08-07): scaffold, design system, Supabase schema + RLS, auth shell, CI.
🟢 **Phase 1 — Personal Hiring Tool** (2026-08-08): jobs + hiring links, public apply flow (rate-limited, idempotent, magic-byte resume validation), Google Drive resume storage (OAuth, root folder, owner-only streaming view), Inbox + application detail + pipeline, Telegram + Resend notifications, Settings integrations. Offline gates all green (60 unit / 9 e2e / lint / typecheck / build); DB-dependent E2E journeys E2–E8 run with `E2E_WITH_DB=1`.
🟢 **Phase 2 — Talent CRM** (2026-08-08): pipeline kanban per job (drag/long-press, optimistic with rollback), bulk actions (≤100 ids), tags + notes with journaled timeline, talent pool (trigram search, filters, applicants profiles, CSV export), application delete (Drive files kept), global `/api/timeline`, reconcile cron, svix-verified Resend bounce webhook, prod CSP, PWA manifest. Gates green (86 unit / 24 always-on e2e / lint / typecheck / build); DB-gated journeys T1–T7 with `E2E_WITH_DB=1`; 10k perf seed via `scripts/seed-perf.mjs`.

🟢 **Phase 3 — AI (BYOK)** (2026-08-08): optional Gemini key (paste → verify → encrypted store, masked hint, instant revoke), resume parsing (`ParsedResume` contract, cached), candidate snapshots (≤120 words + strengths, cached + regenerate, journaled), JD draft assist, social post generator; versioned prompts with injection/hallucination/neutrality guardrails; full degradation matrix (400 without key, 429 friendly, key-rejected banner; core always works). Gates green (109 unit / 29 always-on e2e / DB-gated A1–A4 degradation).

🟢 **Phase 4 — SaaS · v1.0.0** (2026-08-08): multi-tenant organizations with roles (owner/admin/member) + hashed-link invites, workspace switcher (personal ⇄ org scopes everywhere), plan limits free/pro/team (402 `PLAN_LIMIT`), org-first integrations (shared Telegram bot, org Drive, org AI key) with labelled personal fallback, apply-page branding (custom for pro/team, else "via HireLink"), job moves between workspaces, soft-delete with 7-day re-home purge cron, additive zero-data-movement migration `0006`. Gates green (**184 unit / 48 always-on e2e** incl. the org 401 matrix; cross-tenant X1–X10 + 0006 staging rehearsal run against a live Supabase — see `docs/12_Deployment_Guide.md`).

## Docs (read these first)

The complete, cross-referenced spec suite lives in **`docs/`** — start with `docs/00_Master_PRD.md` (locked decisions D1–D8), and `PROJECT_MEMORY.md` for the condensed always-true context. Coding rules: `docs/14_Coding_Standards.md`.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind 4 · Supabase (Postgres 15 + Auth + RLS) · Vercel · Resend (Phase 1) · Telegram Bot API (Phase 1) · Gemini BYOK (Phase 3) · Vitest + Playwright.

## Quickstart

```bash
# Prereqs: Node 20, pnpm (corepack enable), Docker + Supabase CLI
corepack enable && pnpm install

cp .env.example .env.local          # fill values — see docs/12 §2/§3
node scripts/check-env.mjs          # validates .env.local

supabase start                      # local Postgres + Auth (Docker required)
pnpm dev                            # http://localhost:3000
```

Then enable Google provider in Supabase Auth (local or hosted) — setup steps in `docs/12_Deployment_Guide.md` §3/§6.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` / `build` / `start` | Next.js lifecycle |
| `pnpm lint` / `format:check` / `typecheck` | CI quality gates (docs/13 §5) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm e2e` | Playwright critical journeys (mobile viewport) |
| `pnpm db:reset` | Apply migrations + seed locally |

## Invariants (never break)

- RLS on every table; service-role client only in apply route / integration callbacks / cron.
- No public resume URLs, ever; user credentials stored AES-256-GCM (`docs/00` D2/D3).
- Notifications/Drive/AI failures never block application submission (D4).
- `process.env` is read in `src/lib/env.ts` only; route handlers are thin.
- Mobile-first; one primary action per screen.
