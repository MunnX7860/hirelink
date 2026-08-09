# 14 — Coding Standards

> Last updated 2026-08-07. Normative. Enforced by CI where automatable (13 §5).

## 1. Language & Config

- **TypeScript strict mode** (`strict: true`, additionally `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`). No `any` (use `unknown` + narrow); `@ts-expect-error` requires a comment with ticket/reason.
- **ESLint:** `next/core-web-vitals` + `@typescript-eslint/recommended-type-checked` + `eslint-plugin-security`. Blocking rules: `no-floating-promises`, `no-misused-promises`, `no-unsafe-*`, `react-hooks/*`, security hot rules.
- **Prettier:** defaults + `printWidth: 100`, enforced via `prettier --check` in CI (`format:check`).
- Imports ordered by `simple-import-sort`: node → packages → `@/lib` → `@/features` → relative. Path alias `@/* → src/*`.

## 2. Project Structure (feature-based — normative, mirrors 03 §3)

```
src/
  app/                    # routes + route handlers only (thin)
  features/<feature>/{ server.ts, schemas.ts, hooks.ts, components/ }
  lib/{ db, env, crypto, errors, ratelimit }.ts  lib/{storage,notifications,ai,integrations}/
  ui/                     # design-system components (06 §3) — the ONLY place class recipes live
  emails/                 # react-email templates + registry (09)
tests/  e2e/  supabase/migrations/
```

Rules:

1. Route handlers: auth → validate (zod) → call one service → map result/errors via `handleRoute()` wrapper (05 §2). No SQL, no provider SDK imports in `app/`.
2. Server vs client: components default RSC; `"use client"` only where interaction demands. `server-only` package imported in `lib/*` and `features/*/server.ts` so secrets can never reach the client bundle.
3. Feature code imports other features' **public** `server.ts`/`schemas.ts` only; no reaching into `components/` of another feature (compose in `app/`).
4. `lib/env.ts` is the ONLY `process.env` reader (zod-validated, fail-fast); everything else injects config.

## 3. Naming & Idioms

| Thing                   | Convention                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Files                   | kebab-case (`pipeline-stepper.tsx`); tests `*.test.ts(x)` colocated under `tests/__mirrors__` or adjacent |
| Components              | PascalCase; hooks `useX`; services `*Service` or plain verbs (`createApplication`)                        |
| DB columns / API fields | snake_case (04/05) — TS types mirror DB exactly via generated types (`supabase gen types`)                |
| Events/constants        | SCREAMING_SNAKE codes (`JOB_CLOSED`); enums from 04                                                       |
| Booleans                | `is_`, `has_`, `notify_` prefixes                                                                         |
| nanoid slugs            | lowercase alnum; length 8 (jobs), 10 (orgs)                                                               |

## 4. Error Handling & Logging

- Throw `AppError(code, message, { cause })` (`lib/errors.ts`) from services; `handleRoute` maps `code→HTTP` (05 §2). Never catch-and-ignore: catch → handle, or add context and rethrow.
- Provider boundaries try/catch → `DeliveryResult`-style unions instead of throws (03 §6).
- Logging: `lib/logger.ts` structured JSON `{ level, msg, request_id, owner_id?, ... }`. **Never log**: credentials, tokens, resume text, applicant PII beyond IDs, request bodies on apply endpoints (05 §2).
- Client errors: `error.tsx` boundaries per segment with Retry; toasts for action failures (06 §5).

## 5. Database & Data Access

- All schema change = migration file (04 §7); **never** edit via Supabase dashboard on shared envs.
- Use generated `Database` types with supabase-js; write explicit column lists (no `select('*')` outside tiny tables).
- Service-role client imports are restricted to: `apply` feature, integration callbacks, cron — enforced by an ESLint `no-restricted-imports` rule (`lib/db.ts` exports marked).
- Transactions: via Postgres RPC only when multi-write atomicity needed (e.g. application create) — document the RPC in 04 before use.

## 6. Secrets Policy (hard rules)

- Env vars only for platform secrets (12 §2); user credentials only via `lib/crypto.ts` into `integrations.credentials_encrypted`.
- `NEXT_PUBLIC_` prefix requires PR justification comment.
- Pre-commit guard (`gitleaks` in CI) + `no-restricted-syntax` forbidding literal `AIza…`/`xox…`-shaped strings.

## 7. Git & PRs

- **Conventional Commits:** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `db:` (+scope, e.g. `feat(apply):`). Meaningful = says _why_ when non-obvious.
- Small PRs (< ~400 LOC diff) against `main`; one concern per PR; migrations in dedicated commits labelled `db:`.
- PR template checklist: tests added (13 §2)· docs touched · migration safety · PII/logging check · screenshots for UI.
- Every user-visible change also pushes a line into `CHANGELOG.md` and, when architectural, updates `PROJECT_MEMORY.md` — CI reminds via Danger-style check.
- Code review: self-review diff first; reviewer explicitly re-checks RLS/auth paths and failure semantics (03 §6).

## 8. Definition of Done (any change)

typed ✔ lint ✔ formatted ✔ tested per 13 §2 ✔ failure-degradation honoured ✔ docs/CHANGELOG updated ✔ mobile viewport verified (UI) ✔ no new `any`/TODO-without-issue ✔
