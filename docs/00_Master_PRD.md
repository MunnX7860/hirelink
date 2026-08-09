# 00 — Master PRD

> **Working title:** HireLink _(placeholder — rename before public launch)_
> **Status:** Living document. Last updated 2026-08-07.
> This is the **index and executive summary**. Detailed specifications live in the numbered documents below. When documents disagree, raise it — do not guess. Resolve conflicts by editing the source doc and logging the change in `CHANGELOG.md`.

---

## 1. Executive Summary

HireLink is a **mobile-first hiring and talent CRM platform** for businesses that hire through social media (WhatsApp groups, Instagram, Telegram channels, LinkedIn, Facebook). The core mechanic is brutally simple:

1. A business owner creates a **job** and gets a **shareable hiring link**.
2. They post that link anywhere.
3. Applicants fill a short mobile-optimised form and upload a resume.
4. Resumes land in the owner's **own Google Drive**; the owner gets an instant **Telegram** ping and the applicant gets a confirmation **email**.
5. The owner tracks candidates through a lightweight pipeline in a mobile-friendly dashboard.

It starts as a **single-user personal tool** (Phase 1), grows into a **talent CRM** (Phase 2), gains **optional BYOK AI** features (Phase 3), and finally becomes a **multi-tenant SaaS** (Phase 4).

## 2. Problem Statement

Small businesses and solo recruiters who hire through social media currently juggle:

- Resumes arriving scattered across DMs, WhatsApp, and email
- No single place to see "who applied for what"
- No application history, notes, or pipeline
- Enterprise ATS tools (Workable, Greenhouse, Lever) that are expensive, heavy, and desktop-first

They need something closer to "Linktree for hiring" than to an enterprise ATS.

## 3. Goals & Non-Goals

### Goals

| #   | Goal                                                                             | Measured by                              |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| G1  | Create and share a hiring link in **< 2 minutes**                                | Time-to-first-link in onboarding         |
| G2  | Applicant can apply from a phone in **< 3 minutes**                              | Apply-flow completion rate & duration    |
| G3  | Owner notified of every application in **< 1 minute**                            | Telegram delivery latency log            |
| G4  | Zero resume loss — every uploaded file is in the owner's Drive and tracked in DB | Reconciliation check (DB vs Drive)       |
| G5  | Works fully without AI; AI is an accelerator, never a dependency                 | All core E2E tests pass with AI disabled |

### Non-Goals (current horizon)

- Job board / marketplace (we do not source candidates; the owner's audience does)
- Interview scheduling, video interviews, calendar sync (post-Phase 4)
- Background checks, assessments, e-signatures
- Native mobile apps (responsive web + PWA is sufficient)
- Agency-style multi-client portals (until Phase 4 re-evaluation)

## 4. Personas

| Persona                               | Description                                                                                                          | Key need                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Owner-Operator** (primary, Phase 1) | Runs a small business (cafe chain, salon, agency, D2C brand). Hires from Instagram/WhatsApp audience. Not technical. | Post a link, get resumes in a place they own, reply fast. |
| **Solo Recruiter** (Phase 2)          | Manages 5–30 open roles for a handful of clients. Lives on mobile.                                                   | Pipeline view, tags, notes, search across a talent pool.  |
| **HR Team Lead** (Phase 4)            | 2–10 person team in an SMB.                                                                                          | Multi-user org, shared talent pool, roles, branding.      |
| **Applicant** (always)                | Social media follower applying from their phone. May be on flaky data.                                               | Fast, low-friction form; clear confirmation.              |

## 5. Scope by Phase

| Phase | Name                 | Scope (headline features)                                                                                      | Spec docs          |
| ----- | -------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| **0** | Foundation           | Repo, CI, Google login, base schema, design shell, settings                                                    | 03, 04, 12, 14     |
| **1** | Personal Hiring Tool | Jobs + hiring links, public apply form, Google Drive resume storage, dashboard, Telegram + email notifications | 02, 05, 07, 08, 09 |
| **2** | Talent CRM           | Pipeline stages, tags, notes, timeline, search/filter, archive, talent pool                                    | 02, 04, 05         |
| **3** | AI (optional, BYOK)  | Resume parsing, candidate summaries, JD generator, social post generator                                       | 10                 |
| **4** | SaaS                 | Organizations, roles, per-org storage/integrations/branding, plans & limits                                    | 11                 |

Detailed scope, deliverables, and exit criteria per phase: **15_Project_Roadmap.md**.

## 6. Product Principles (guardrails for every decision)

1. **Mobile-first.** Every screen is designed for a 360px viewport first, then scaled up.
2. **One primary action per screen.** If a screen has two primary buttons, it is two screens.
3. **The core never blocks.** A failed email, Telegram ping, Drive upload, or AI call must never fail a job submission or application. Degrade, flag, retry. (See 03 §Resilience.)
4. **User owns the data.** Resumes live in the user's Drive; the DB stores references, not files. Export must always be possible.
5. **AI optional.** Every AI feature has a complete non-AI path.
6. **Modular.** Features are isolated modules behind interfaces (storage, notifications, AI) so they can be replaced per-tenant later.
7. **Secure by default.** RLS on every table, encrypted credentials, no public file URLs, minimal OAuth scopes.

## 7. Success Metrics (North Star + inputs)

- **North Star:** _Applications successfully processed per week_ (submitted → stored → owner notified).
- Activation: % of new users who create a link within 24h (target > 60%).
- Reliability: application submission success rate (target ≥ 99.5%), notification delivery ≥ 99%.
- Retention: weekly active hiring users.
- Phase 3: AI feature adoption among active users (target 25% attach rate, BYOK).

## 8. Technical Summary (one paragraph)

Next.js 15 (App Router) + React 19 + TypeScript strict + Tailwind on **Vercel**; PostgreSQL with Row-Level Security on **Supabase** (also provides Google OAuth login); user-owned **Google Drive** as Phase 1 file storage behind a `StorageProvider` interface; **Telegram Bot API** and **Resend** for notifications behind a `NotificationService`; **Gemini** via bring-your-own-key in Phase 3 behind an `AIProvider` interface. Full rationale in **03_System_Architecture.md**.

## 9. Key Cross-Cutting Decisions (summary of the decision log)

| ID  | Decision                                                                                                                 | Where specified |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------- |
| D1  | Supabase Auth (Google OAuth) for login; separate incremental Google OAuth (`drive.file` scope) for Drive                 | 03, 07          |
| D2  | Files stored in user-owned Google Drive in Phase 1; `storage_file_id` in DB; **no public file URLs ever**                | 04, 07          |
| D3  | Resumes/decryption keys encrypted at rest with AES-256-GCM (`ENCRYPTION_SECRET`)                                         | 07, 10          |
| D4  | Notifications are fire-and-forget with one retry; they never block submissions                                           | 03, 08, 09      |
| D5  | Multi-tenancy via `organization_id` columns + RLS from day one (nullable; backfilled in Phase 4)                         | 04, 11          |
| D6  | Application pipeline status enum: `new → reviewing → shortlisted → interview → offered → hired` + `rejected`, `archived` | 02, 04          |
| D7  | AI is strictly BYOK, Gemini first; no platform-paid AI keys                                                              | 10              |
| D8  | Public apply flow is unauthenticated, slug-addressed, rate-limited, and idempotent per (job, email)                      | 05              |

## 10. Glossary

| Term             | Meaning                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Job**          | A role with a unique **hiring link** (`/apply/{slug}`).                                      |
| **Applicant**    | A person (deduped by owner + email). Reusable across jobs (talent pool).                     |
| **Application**  | The join of Applicant × Job with a pipeline **status**.                                      |
| **Hiring link**  | Public, unauthenticated URL for the apply form.                                              |
| **Owner**        | The authenticated user who owns jobs/applicants (Phase 1–3).                                 |
| **Organization** | Phase 4 tenant that owns users, storage, integrations, branding.                             |
| **Integration**  | A connected external service record (Drive, Telegram, email, AI) with encrypted credentials. |
| **BYOK**         | Bring Your Own (AI) Key — users supply their own Gemini key.                                 |

## 11. Document Index

| Doc                              | Contents                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| `00_Master_PRD.md`               | This file — index, summary, decisions                      |
| `01_Product_Vision.md`           | Mission, positioning, principles, metrics                  |
| `02_User_Flows.md`               | Detailed flows: admin, applicant, integrations, edge cases |
| `03_System_Architecture.md`      | Stack, module boundaries, folder structure, resilience     |
| `04_Database_Design.md`          | Full SQL schema, enums, indexes, RLS, migrations, seeds    |
| `05_API_Specification.md`        | REST endpoints, zod schemas, error model, rate limits      |
| `06_UI_UX_Guidelines.md`         | Design tokens, components, screens, states, a11y           |
| `07_Google_Drive_Integration.md` | OAuth, folder layout, upload flow, token lifecycle         |
| `08_Telegram_Integration.md`     | Bot setup, message templates, failure handling             |
| `09_Email_System.md`             | Provider, templates, variables, deliverability             |
| `10_AI_Architecture.md`          | BYOK, provider interface, features, prompts, costs         |
| `11_SaaS_Architecture.md`        | Multi-tenancy, roles, plans, migration path                |
| `12_Deployment_Guide.md`         | Environments, env vars, CI/CD, production checklist        |
| `13_Testing_Strategy.md`         | Test pyramid, tools, coverage, release QA                  |
| `14_Coding_Standards.md`         | TS/ESLint/Prettier, structure, naming, commits, PRs        |
| `15_Project_Roadmap.md`          | Phases, deliverables, exit criteria, estimates             |
| `CHANGELOG.md`                   | Every significant change to product or docs                |
| `PROJECT_MEMORY.md`              | Condensed always-true context for AI coding sessions       |
