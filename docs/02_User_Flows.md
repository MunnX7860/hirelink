# 02 — User Flows

> Last updated 2026-08-07. Statuses, endpoints and field names here are normative and match `04_Database_Design.md` and `05_API_Specification.md`.
> Convention: ✅ = happy path, ⚠️ = edge case, 🔁 = retryable failure. "Owner" = authenticated dashboard user.

## 0. Pipeline Status Model (used by all flows)

```
new → reviewing → shortlisted → interview → offered → hired
 │        │            │            │          │
 └────────┴──── any state ─────────┴──────────┴──→ rejected
any state → archived  (archive is a status, reversible: unarchive → previous status)
```

- `new` is set automatically on submission.
- Owners may move an application to **any** status (no forced linearity); every change writes a `status_changed` `timeline_events` row recording `from`/`to`.
- `archived` hides the application from default list views; unarchiving restores the last non-archived status (stored in the event payload).

---

## 1. Owner Authentication Flow ✅

1. Owner opens `/login` → taps **Continue with Google** (the only button; one primary action).
2. Supabase Auth performs Google OAuth (scopes: `openid email profile`).
3. Callback → session cookie set (`@supabase/ssr`).
4. DB trigger `handle_new_user` (04 §Triggers) upserts `public.users` on first login.
5. Redirect: to `/dashboard`; if user has **no Drive integration**, dashboard shows a one-time connect banner (dismissible).

**⚠️ Edge cases**

- OAuth error/cancel → back to `/login?error=oauth` with a human message; retry allowed.
- First login on mobile browser with 3rd-party cookies blocked → full-redirect flow is used (no iframes/popups required after initial redirect).

---

## 2. Create Hiring Link (Job Creation) ✅

1. Dashboard → **+ New Job** (primary FAB).
2. `GET /dashboard/jobs/new` — form with **only**:
   - Job title _(required, 3–120 chars)_
   - Description _(optional, plain text, 5000 max)_
   - Resume _(toggle: Required / Optional — default Required)_
   - Phone _(toggle: Required / Optional / Hidden — default Optional)_
   - Cover note _(toggle: Optional / Hidden — default Hidden)_
3. Save → `POST /api/jobs` → server generates unique 8-char `slug` (nanoid, lowercase alnum), status `active`.
4. Success screen shows the **hiring link** `https://{app}/apply/{slug}` with a big **Copy link** button + native share sheet on mobile. One primary action.
5. `timeline` n/a (job-level event not needed); job appears in **Jobs** list.

**⚠️ Edge cases**

- Validation errors → inline per-field (zod messages from 05 §Validation).
- Owner has no Drive connected and resume = Required → allow creation but show warning banner: _"Resumes can't be stored until Google Drive is connected"_; apply form still accepts submissions and marks resume `upload_status='failed'` with retry (Flow 5).
- Duplicate titles are allowed (slug is the identity, not the title).

---

## 3. Share Link ✅

1. Copy / share from job success screen, job card menu, or job detail header.
2. Optional auto caption (Phase 3 may AI-generate; Phase 1 static template): _"We're hiring: {title}. Apply here: {link}"_.

---

## 4. Applicant Apply Flow (public, unauthenticated) ✅

1. Applicant opens `GET /apply/{slug}` → server renders job title/description + form per job's `form_config`.
2. Form fields: **Full name** (always required), **Email** (always required), and Phone / Cover note / Resume per config. Resume accepts **PDF, DOC, DOCX, ≤ 10 MB** with client-side pre-check.
3. Submit → `POST /api/apply/{slug}` (multipart). Server, in order:
   1. Rate-limit check (per IP; 05 §Rate Limits) — 🔁 failure → HTTP 429, friendly retry message.
   2. Validate payload; invalid → HTTP 400 with field errors, no side effects.
   3. Load job; if `status != 'active'` → render "This position is closed" (HTTP 410 semantics).
   4. Upsert `applicants` on `(owner_id, email)`.
   5. **Idempotency:** if `(job_id, applicant_id)` already exists → do NOT duplicate; respond success with "You've already applied" message (still send no emails again). Conflict is swallowed to keep UX idempotent.
   6. Insert `applications` (`status='new'`) + `timeline_events` (`application_created`).
   7. If resume present: upload to owner's Drive via `StorageProvider` into `{Root}/Jobs/{JobTitle}-{jobId[:8]}/` (07 §Folder Layout) → insert `resumes` row (`uploaded`) + `resume_uploaded` event. **🔁 Failure:** application stays created; `resumes.upload_status='failed'`; owner alerted via Telegram; dashboard job/applicant shows "Resume upload failed — retry" action (`POST /api/applications/:id/retry-resume` requires the raw file → owner can ask applicant to re-send; v1 retry path = applicant resubmits via link, upsert path in step 5 replaces resume row only if a new application is allowed — see ⚠️ below).
   8. **Fire-and-forget** notifications (one retry, exponential 5s→15s, then stored as `email_failed`/`telegram_failed` timeline events):
      - Telegram to owner (08 §Template).
      - Confirmation email to applicant (09 §Templates).
4. Success screen: "Application received ✅ — {Job Title}. We've emailed you a confirmation." No account, no tracking pixels.

**⚠️ Edge cases**

- **Duplicate application** (same email, same job): success response, no side effects, no resume overwrite. (Re-applying with a new resume is a Phase 2+ feature; v1 tells the applicant they already applied.)
- **Closed job link**: page renders job title + "closed" notice, no form.
- **Invalid file type/size**: client blocks; server re-validates → 400 with clear message.
- **Owner's Drive token expired/revoked**: upload attempt refreshes token (07 §Token Lifecycle); if refresh fails → `upload_status='failed'`, application still succeeds, owner notified to reconnect Drive.
- **Flaky connection mid-upload**: client uses a single fetch with progress; on network drop applicant sees "Connection lost — tap to retry" (form state preserved in memory; file input must be re-picked on some mobile browsers — acknowledged limitation).

---

## 5. Owner Reviews Inbox (Dashboard) ✅

1. `/dashboard` = **Inbox**: applications with `status='new'` across all jobs, newest first, unread-style emphasis.
2. Each card: name, job title, time since applied, phone/email, tag strip, status pill.
3. Tap card → `/dashboard/applications/{id}` detail:
   - Contact info, cover note, resume actions (**View in Drive**, filename link; never an inline public URL — 07 §Access), AI summary slot (Phase 3), pipeline stepper, notes, timeline.
   - Primary action = **advance** (next sensible status) via bottom action bar; overflow menu = any status, archive.

**⚠️** Deleting an application (Phase 2) also deletes its `resumes` rows but **not** the Drive file in v1 (Drive file remains; manual cleanup — documented in 07 §Disconnect/Deletion).

---

## 6. Pipeline Management (Phase 2, spec'd now) ✅

- **Board view** per job: columns per status, drag-drop on desktop, long-press move on mobile; every move = status change event.
- **Bulk actions**: select N → change status / add tag / archive → single `PATCH /api/applications` batch call (05).
- **Filters**: by job, status, tags, date range, free-text over name/email (server-side, trigram index — 04 §Indexes).

---

## 7. Talent Pool (Phase 2, spec'd now) ✅

1. `/dashboard/applicants` — all people across jobs, deduped by email.
2. Applicant profile: all their applications, tags, notes, timeline.
3. Tags: create inline (`POST /api/tags`), colored chips, applied via `applicant_tags`.
4. Notes: created from applicant or application detail; `notes` rows appear in timeline as `note_added`.

---

## 8. Integration Setup Flows

### 8.1 Google Drive (Phase 1) ✅

1. Settings → Integrations → **Connect Google Drive**.
2. Separate Google OAuth (NOT the login one) requesting `drive.file` scope only, `access_type=offline`, `prompt=consent` (07 §Scopes).
3. Callback stores encrypted refresh token in `integrations` (`type='google_drive'`).
4. Owner picks (or creates) a **root folder** via a simple Drive picker (list user's folders through the stored token); choice stored in `integrations.config.root_folder_id`.
5. Status = `active`. 🟢

**🔁** Token revoked → status `error`, dashboard banner, uploads degrade per Flow 4. **Disconnect** → status `disconnected`, tokens deleted from DB; Drive files stay (user owns them).

### 8.2 Telegram (Phase 1) ✅

1. Settings → Integrations → Telegram: guided steps — chat with `@BotFather`, create bot, paste **bot token** + **chat ID** (helper explains how to get chat ID; a "Test message" button verifies: `POST /api/integrations/telegram/test`).
2. Saved encrypted (`type='telegram'`), status `active` after successful test message.

### 8.3 AI Key (Phase 3)

1. Settings → AI: paste Gemini API key → verified with a trivial `generateContent` ping → encrypted into `integrations` (`type='ai'`).
2. Without a key, all AI UI is present but disabled with an explainer (10 §Graceful Degradation).

---

## 9. Owner Account & Danger Zone

- Settings → Profile: name, email (read-only from Google), default notification toggles (`settings` table: `notify_telegram`, `notify_email_applicant`).
- Data: "Export my data" (Phase 2: CSV/ZIP via Drive listing) and "Delete account" (Phase 4) — deletion removes DB rows + stored tokens, **never** the user's Drive files.

---

## 10. Organization & Team Flow (Phase 4)

1. **Create org:** Settings → Workspace → "Create organization" (name 2–120). Creator becomes org `owner`; workspace switcher (top bar) appears. First login after activation with ≥1 membership → one-time chooser: stay personal or default to an org.
2. **Switch workspace:** header switcher (Personal / each org). POST `/api/orgs/current` validates membership, sets cookie + default. All lists re-scope instantly (11 §1 query rule).
3. **Invite:** org owner/admin → Settings → Workspace → Members → invite by email + role (admin/member). 7-day token link (also emailed, `org_invite` template best-effort). Invitee signs in (Google), opens link → accept screen (org name, role, inviter) → Accept → member. Email must match the signed-in account; wrong account → explicit 403 copy.
4. **Work:** members see shared jobs/pipeline/applicants/tags/timeline; integrations resolve org-first (11 §3); org Drive = shared company Google account; org AI key = shared BYOK pool, else member's own.
5. **Plan caps:** free org → 3 active jobs / 1 seat; past cap → 402 `PLAN_LIMIT` with upgrade copy; founder flips plan in DB (manual billing era — 11 §4).
6. **Move job:** job detail → ⋯ → "Move to…" personal⇄org (creator or org admin+; plan check on the target).
7. **Leave/delete:** members self-leave; org owner deletes org → 7-day soft-delete grace (instant lockout, owner can restore) → purge cron re-homes rows to creators' personal workspaces (no data loss, 11 §7).

---

## 12. Screening & AI Shortlisting Flow (Phase 5, normative rules in 17)

1. **Build the questionnaire:** Job edit → "Screening questionnaire" → add questions (type, options, classification). Mandatory = pick the qualifying rule (e.g. _experience_years ≥ 2_). "Candidate view" preview shows exactly what applicants see — rules are never shown outside the builder (17 §3.4).
2. **Candidates answer:** public apply form renders questions under contact fields, before resume upload; required marked `*`. Submission stores answers + computes the verdict instantly (no AI involved).
3. **Verdict surfaces:** job detail Screening tab counters (Qualified / Review / DNMC); application detail shows the Questionnaire card + verdict badge. Nobody is deleted — DNMC stays in the talent pool and all lists (17 §4).
4. **Start an AI screening (optional):** Screening tab → New screening → choose pool (live counts, default = Qualified) → write instruction in plain language → set max (upper bound, not a quota) → Start. Job context is auto-packed; the recruiter never re-types the JD. No key → the 10 §6 explainer with a link to Settings → AI.
5. **Processing:** session card shows live progress (`127 / 500 processed`). Leave the page freely — the worker keeps going (cron + advance-on-view); quota pauses auto-resume.
6. **Review results:** grouped Strong / Possible / Review / Lower; every row expands to reasons, evidence, uncertainties ("Not clear from resume" for missing data); one tap to the full application + original resume. Re-rank/override via the normal pipeline actions — AI never touches statuses (17 §14).
7. **Iterate:** start a second session with a refined instruction — history is append-only ("Screening #1: 42 strong matches …"). Failed rows get a **Retry failed** button (session counts stay honest).
8. **Degradation:** everything except the AI steps works with no key, mid-run key revocation fails the session visibly with a re-connect CTA.

---

## 13. Error-State Principles (apply to every flow)

1. Applicant-facing errors are human, actionable, and never expose internals (`05 §Error Model` — no stack traces, `code` + `message`).
2. Owner-facing integration failures always surface twice: inline on the affected record **and** once in a global settings banner.
3. Every failure that loses data (resume upload failure) writes a `timeline_events` row so it is auditable.
