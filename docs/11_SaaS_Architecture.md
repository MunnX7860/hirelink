# 11 — SaaS Architecture (Phase 4)

> Last updated 2026-08-08 (Phase 4 implementation pass). Normative for Phase 4. Ground rule (D5): multi-tenancy is **designed-in from day one** — `organization_id` columns + membership tables shipped in `0002`–`0004` migrations — so Phase 4 is an _activation_, not a rewrite.

## 1. Tenancy Model

**Single database, shared schema, row-level isolation** via `organization_id` + Postgres RLS. Rationale: our tenants are SMBs (tens–hundreds of rows scale), opinions stay simple (one Supabase project), and joins across an org's own data stay natural. Explicitly rejected: schema-per-tenant (migration hell), DB-per-tenant (ops cost at low ARPU).

### Hierarchy

```
organizations ─┬─ organization_members (user × org, role)
               ├─ organization_invites (pending seats, 7d expiry)
               ├─ jobs, applicants, tags, integrations (organization_id FK)
               └─ brand (jsonb), plan
Personal workspace = rows with organization_id IS NULL AND owner_id = user
```

- Every owned table carries **both** `owner_id` (creator/original owner; never null) and `organization_id` (null = personal). **Org-scoped read/write == `organization_id = current_org`.**
- `tags` gains `organization_id` in `0006` (team tags in the shared pool). **Decision (logged):** pre-existing personal tags stay personal — they are NOT merged into the org pool; tags created while switched into an org are org tags. Per-member personal tags inside the org pool are out of scope for v1.0.
- `applications`, `resumes`, `timeline_events`, `notes`, `applicant_tags` carry **no** `organization_id` — they inherit scope from their parent job/applicant (RLS joins up; services resolve scoped parent ids first).

### Workspace resolution (normative mechanics)

A **WorkspaceContext** is exactly one of:

```ts
{ kind: 'personal', ownerId: string }              // role: implicit full control
{ kind: 'org', ownerId: string, orgId: string, role: 'owner'|'admin'|'member' }
```

Resolution per request (`requireWorkspace()` in `features/orgs/server.ts`):

1. Cookie `hl_org` = `personal` | org UUID (httpOnly, sameSite=lax, 1y, set by `POST /api/orgs/current`).
2. Else `users.default_organization_id` when the user is still a member of that org.
3. Else **personal** (the forever-valid default; data rows pre-Phase-4 all live here).

Any candidate org failing the live membership check is silently skipped (membership changes take effect immediately — no caching, §7). `hl_org` may point at a soft-deleted org → resolves to personal.

**Query rule (normative, application layer — companion to RLS):** every read/write on owned tables passes through the scope:

| Table                                  | personal filter                                 | org filter                       |
| -------------------------------------- | ----------------------------------------------- | -------------------------------- |
| jobs, applicants, tags, integrations   | `owner_id = uid AND organization_id IS NULL`    | `organization_id = :org`         |
| applications, resumes                  | via job ids resolved in scope first             | via job ids resolved in scope    |
| notes, timeline_events, applicant_tags | via applicant/application ids resolved in scope | via parent ids resolved in scope |

Detail endpoints apply the same filters → out-of-scope ids are **404** (no existence leak, docs/05 §2). Helpers live in `features/orgs/scope.ts` (`applyScope()`); services receive the `Scope` object explicitly — no ambient state.

## 2. Roles & Permissions

| Capability                           | owner |     admin      |      member      |
| ------------------------------------ | :---: | :------------: | :--------------: |
| Jobs: create/edit/close/move         |  ✅   |       ✅       |        ✅        |
| Applications: review/move/notes/tags |  ✅   |       ✅       |        ✅        |
| Integrations: connect/disconnect     |  ✅   |       ✅       | ❌ (read status) |
| Members: invite/change role/remove   |  ✅   | ✅ (not owner) |        ❌        |
| Branding & plan/billing              |  ✅   |       ❌       |        ❌        |
| Transfer ownership / delete org      |  ✅   |       ❌       |        ❌        |

Enforcement: `authorize(workspace, capability)` in `src/lib/authz.ts` — the table above encoded as data (`CAPABILITIES`), plus explicit override rules that live outside the matrix (documented next to the capability they guard):

- `members.manage`: admin may invite/change/remove **members** only (never the org owner, never another admin's role grant above their own).
- `org.transfer`, `org.delete`, `org.branding`: org **owner** (the `organizations.owner_id` row) — not merely the `owner` _role_: after `transfer` the old owner becomes `admin` and the new owner gets `owner` role; only `organizations.owner_id` may transfer again.
- Self-leave (`DELETE members/me`): any non-owner member.
- Job move (`POST /api/jobs/:id/move`): the job's creator, or org owner/admin of the **source** scope when the job is org-owned.

Throws 403 `FORBIDDEN` (docs/05 §2). RLS stays the backstop (§5); authz is the first line at the service layer (defense in depth).

## 3. What an Organization Owns

| Resource          | Resolution rule (implemented in `lib/integrations/resolve.ts`)                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Users**         | `organization_members`; dashboard defaults to personal unless switched/defaulted (§1)                                                                                                                                                                                                             |
| **Storage**       | Org-level Drive row wins; falls back to the **job creator's** personal integration; else degraded (03 §6). Org connects use a shared company Google account — the same OAuth flow, `state` carries `org` (`POST /api/integrations/google/start?org=:id`, admin+ capability `integrations.manage`) |
| **Integrations**  | `integrations.organization_id = :org` rows take precedence over `owner_id` rows of the same `type`. Settings page renders the org section read-only to members                                                                                                                                    |
| **Telegram**      | Same precedence. Org admins may instead opt into the **shared platform bot**: `config.shared = true`, credentials null → token sourced from env `TELEGRAM_SHARED_BOT_TOKEN` (org-only feature; personal workspaces always use their own bot). docs/08 §5                                          |
| **API Keys (AI)** | Org BYOK row (`type=ai`, org set) optional; otherwise the calling member's own key is used (10 §BYOK)                                                                                                                                                                                             |
| **Branding**      | `organizations.brand = { logo_url, primary_color, email_from_name }` — applied to: apply page header (§9), transactional email `company_label`/from-name (09 §2.1). Custom branding requires plan ≠ free (§4)                                                                                     |

## 4. Plans & Limits (enforced at service layer, not DB)

| Limit                  | free                 | pro    | team   |
| ---------------------- | -------------------- | ------ | ------ |
| Active jobs            | 3                    | 25     | 100    |
| Seats                  | 1                    | 3      | 25     |
| Applications stored    | 500                  | 10k    | 50k    |
| AI features            | BYOK ✔               | ✔      | ✔      |
| Branding on apply page | "via HireLink" badge | custom | custom |
| Price (placeholder)    | $0                   | $12/mo | $39/mo |

Data lives in `src/lib/plans.ts` (`PLAN_LIMITS`). Personal workspaces are governed by the **free** row (a personal plan purchase channel does not exist in Phase 4 — manual billing era).

Enforcement (normative, per limit key):

| Key                   | Where                                                                  | Exceeded behaviour                                                                                               |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `jobs.active`         | `createJob`, `PATCH` closed→active, job **move-in** to org             | 402 `PLAN_LIMIT` `{ limit, used, plan }`; upgrade copy                                                           |
| `seats`               | invite create **and** invite accept (counts members + pending invites) | 402 `PLAN_LIMIT`                                                                                                 |
| `applications.stored` | usage surfaced in org settings + `GET /api/orgs/:id`                   | **surfaced only in Phase 4** — hard applicant-facing cap deferred with billing (never silently fail a candidate) |
| branding custom       | `PATCH /api/orgs/:id` brand fields                                     | 402 `PLAN_LIMIT` (`details.upgrade: 'pro'`)                                                                      |

`assertWithinPlan(plan, key, used)` is pure/testable; counts are cheap `count(*)` on indexed columns (04 §4). Payments are **not built in Phase 4** — plans flip manually in DB (founder-led sales); Stripe deferred (15 §Backlog).

## 5. RLS Evolution (additive, no rewrites — 04 §6)

`0006` ships helper `public.current_org_role(org uuid) returns member_role` (**security definer, stable** — bypasses RLS to avoid policy recursion on `organization_members`; returns null for soft-deleted orgs, which makes every org policy below inert the moment an org is deleted) and adds:

```sql
create policy jobs_org_member on public.jobs for all
  using ( public.current_org_role(organization_id) is not null )
  with check ( public.current_org_role(organization_id) is not null );
-- same pattern: applicants, tags, integrations (manage = owner/admin variant),
-- applicant_tags/notes via applicant parent join, resumes/applications via job join,
-- timeline_events org SELECT only (writes stay owner_id = actor).
-- organizations/organization_members/organization_invites policies: 04 §6.
```

Service-layer companions: 402/403 enforcement as §2/§4; services always set `organization_id` explicitly when acting in org context; personal rows (`null`) stay invisible to other org members even if they know an ID — 404 semantics (05 §2).

## 6. Migration Path (Phase 4 activation)

1. `0006_phase4_orgs.sql` (schema, idempotent — every statement guarded or rerun-safe):
   - `organization_invites` + `organizations.deleted_at` + FK `users.default_organization_id → organizations` + `tags.organization_id`.
   - Org-dedupe partial unique index `applicants (organization_id, email) where organization_id is not null`; tags per-scope unique indexes.
   - Helper functions `current_org_role`, `lookup_invite`, `accept_org_invite` (security-definer; services never need the service-role client on org routes).
   - Additive RLS policies (§5).
   - **Backfill:** for every existing user → create personal org _"{Name}'s workspace"_ with owner membership, guarded by `where not exists (owned org)`. **Data rows are untouched (`organization_id` stays NULL)** — zero data movement. `users.default_organization_id` is intentionally NOT set by the migration (personal remains the default view; nothing disappears from anyone's dashboard).
2. Users can move jobs between workspaces via `POST /api/jobs/:id/move` (updates the job, plus re-scopes applicants whose applications all live within the target scope; single tx semantics via ordered updates). Bulk multi-job move = future polish.
3. First login after activation with ≥1 membership → org chooser surfaces once ("Stay personal" / pick org); choice persists to `users.default_organization_id`. The standalone runner `scripts/backfill-orgs.mjs` mirrors step 1 for users created mid-cutover (idempotent, `--dry-run` supported).
4. Rehearsal (exit gate): apply `0006` to a staging dump of prod shapes, run `scripts/backfill-orgs.mjs --dry-run`, diff counts. Snapshot before run.

**Applicant dedupe in orgs (normative):** an application submitted to an org-owned job dedupes against the **org pool first** (`organization_id = :org, email`), then against the job owner's personal pool — a personal match is **re-scoped into the org** (the shared pool wins; the applicant now appears in org searches; journaled via existing `applicant_created`/`application_created` only — no synthetic "moved" event). New applicants created through org jobs get `owner_id = job.owner_id`, `organization_id = :org`.

## 7. Security & Privacy at Scale

- Membership changes take effect immediately (server-side membership checks are not cached; RLS is the backstop — §1).
- Org deletion: `organizations.owner_id` only, soft-delete (`deleted_at`, 7-day grace) → `POST /api/orgs/:id/restore` within the window; then `GET /api/cron/org-purge` (daily 04:00 UTC, `CRON_SECRET`) hard-deletes the org shell + memberships + invites + org-scoped integrations, and **re-homes data rows to their creators' personal workspaces** (`organization_id := null`) — no customer data is destroyed by org teardown. The settings danger zone links CSV export first (§"exports offered first").
- Invite tokens: 24-char nanoid, stored as **SHA-256 hash** (`token_hash`); raw token exists only in the invite URL/email. 7-day expiry, single use.
- Cross-tenant leaks are P0-class: 13 §3 Phase 4 mandates the Playwright tenant-isolation suite (X1–X10) enumerating every list/detail route against tenant-B fixtures asserting 404/`[]`.

## 8. What Phase 4 Explicitly Does Not Include

Stripe/payments UI, audit-log export, SSO/SAML, public customer API, white-label domains, regional data residency. Each is a Phase 5 candidate (15 §Backlog). **Decision (logged):** the internal UI API stays unversioned `/api/*` in Phase 4 (docs/05 §6) — `/api/v1` ships when a public API is committed to, not before.

## 9. Branding on the Public Apply Page (normative)

- Job has no org (personal) OR org plan = free → standard chrome + explicit **"via HireLink"** badge (footer pill). No custom accents.
- Org plan ∈ {pro, team} → apply page renders the org header block: `brand.logo_url` (when set), org display name, `brand.primary_color` accent on the primary button/title rule; footer keeps the single legal line (privacy) but the HireLink wordmark pill is omitted.
- Email from-name/`company_label`: `brand.email_from_name ?? org.name` for org jobs; owner full name otherwise (05 §4.7b, 09 §2.1).
