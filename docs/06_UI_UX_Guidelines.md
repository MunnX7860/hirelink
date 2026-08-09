# 06 — UI/UX Guidelines

> Last updated 2026-08-07. Normative for all screens. Principles baseline: `01 §5`. Screen flows: `02`.

## 1. Design Principles (ranked)

1. **Mobile-first** — designed at 360×800, then `sm(640) → md(768) → lg(1024) → xl(1280)`. Nothing desktop-only.
2. **One primary action per screen** — exactly one filled primary button per viewportful; everything else secondary/ghost/menu.
3. **Large touch targets** — ≥ 44×44px hit area; primary CTAs full-width at bottom on mobile (thumb zone), 16px+ label text.
4. **Minimal fields** — never ask for what has a sensible default (defaults in 02 §2). No optional-marked clutter: mark the _required_ ones instead.
5. **Responsive layouts** — single-column mobile; persistent header; bottom action bar for contextual primary actions; no hover-dependent affordances.
6. **Consistent spacing** — 4pt grid: `4, 8, 12, 16, 24, 32, 48`. Card padding 16 (mobile) / 24 (desktop). Section gaps 24/32.
7. **Forgiving states** — errors say what happened and what to do; nothing ever disappears without undo or a confirm.

## 2. Design Tokens (Tailwind theme source of truth)

| Token           | Value                                       | Usage                                 |
| --------------- | ------------------------------------------- | ------------------------------------- |
| `color.brand`   | indigo `#6366f1` / hover `#4f46e5`          | primary actions, links, active states |
| `color.success` | `#16a34a`                                   | applied/created confirmations         |
| `color.warning` | `#d97706`                                   | integration degraded                  |
| `color.danger`  | `#dc2626`                                   | destructive, failed statuses          |
| `surface`       | `#ffffff` / muted `#f8fafc`                 | cards / page bg                       |
| `ink`           | `#0f172a` primary, `#475569` secondary      | text                                  |
| `radius`        | `8px` default, `12px` cards, `999px` pills  |                                       |
| `shadow`        | cards: `0 1px 2px rgb(15 23 42 / .06)`      | subtle only                           |
| `font`          | system stack (`ui-sans-serif, system-ui`)   | zero webfont FOUT on 3G               |
| `type scale`    | 12 / 14 / 16 / 20 / 24 / 30 (`text-xs…3xl`) | body=16 mobile                        |

**Status colors (applications):** `new`=indigo, `reviewing`=sky, `shortlisted`=violet, `interview`=amber, `offered`=teal, `hired`=green, `rejected`=red-400, `archived`=slate-400. Pills: colored-bg/10 + colored text, uppercase 11px.

**Dark mode:** not in Phase 1–3 (tokens above are chosen to allow a later pass without component rewrites).

## 3. Component Inventory (build once, reuse)

`Button (primary|secondary|ghost|danger; sm|md|lg; loading state)` · `IconButton` · `Input / Textarea / Select / Switch (all with label, hint, error slots)` · `FileDrop` (mobile: native picker + progress bar; drag-drop only ≥md) · `Card` · `ListItem / ApplicantCard` · `StatusPill` · `TagChip` (colored, removable) · `PipelineStepper` (horizontal scroll mobile) · `Tabs` · `Sheet/Drawer` (mobile bottom sheet for actions) · `Toast` (top-center mobile; auto-dismiss 4s; action slot for Undo) · `Modal` (confirms only — destructive) · `EmptyState` (icon, one-line, primary CTA) · `Banner` (integration degradation, settings link) · `Skeleton` (list/detail) · `Avatar` · `FAB` (New Job / primary create) · `SearchField` · `FilterBar` (chips + sheet) · `TimelineItem` · `CopyButton` (with "Copied ✓" feedback).

Implementation: styled primitives over **Tailwind** (no heavy component lib); headless behavior from Radix UI where needed (Sheet, Modal, Tabs, Toast). Class authority lives in `src/ui/` — features never redefine button styles (14 §Structure).

## 4. Screen Inventory & Notes

### Public

| Screen                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`               | Logo, one Google button, error copy if `?error=oauth`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/apply/[slug]`        | ⚡ perf-critical: RSC, no dashboard JS. Header = job title + short description; form per `form_config`; sticky submit; client validation mirrors zod; upload progress bar; success state replaces form (no redirect). Closed job → friendly 410 state. Honeypot hidden input `website`. **Phase 5:** questionnaire questions render between contact fields and resume upload (native inputs only — radio/checkbox/select/number/text; required = red `*`; no rules/scoring hints, 17 §3.3–3.4); same ≤60 KB budget, measured at ship-time |
| Legal/footer microcopy | "Your resume is stored securely by the employer." links → privacy note (Phase 2 page).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Authenticated shell

Layout: top bar (logo, job switcher-sm, avatar menu) · bottom tab bar on mobile (**Inbox · Jobs · People · Settings** — ≤ 4) / left rail ≥lg. FAB context-aware (+ New Job on Jobs/Inbox).

| Screen                                | Primary action        | Notes                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard` (Inbox)                  | Review → tap card     | `new` applications across jobs; pull-to-refresh; empty state → "Share your first hiring link"                                                                                                                                                                                                                    |
| `/dashboard/jobs`                     | + New Job             | cards: title, status, counts (new/total), copy-link quick action                                                                                                                                                                                                                                                 |
| `/dashboard/jobs/new`                 | Create job & get link | minimal form (02 §2). Success = link view with Copy + Share-sheet                                                                                                                                                                                                                                                |
| `/dashboard/jobs/[id]`                | Share link            | stats strip, pipeline preview, link to filtered applications; edit/sheet menu (Close/Archive job)                                                                                                                                                                                                                |
| `/dashboard/applications/[id]`        | Advance pipeline      | contact card, cover note, resume row → View (streams via API), AI summary slot (P3, else hidden), stepper, notes composer, timeline                                                                                                                                                                              |
| `/dashboard/applicants` (P2)          | Search/filter         | People list w/ tags                                                                                                                                                                                                                                                                                              |
| `/dashboard/applicants/[id]` (P2)     | Add note              | all applications + tags + timeline                                                                                                                                                                                                                                                                               |
| `/dashboard/pipeline/[jobId]` (P2)    | Move cards            | kanban per status; long-press mobile; optimistic updates w/ rollback toast                                                                                                                                                                                                                                       |
| `/dashboard/jobs/[id]/screening` (P5) | Review AI results     | tab beside Pipeline (17 §12): pool counters card, sessions list (status/counts/creator), New-screening form (pool picker w/ live counts, instruction, max-N), results grouped strong/possible/review/lower w/ expandable reasons-evidence-uncertainties, live progress `x / N processed`, Retry-failed secondary |
| `/dashboard/settings`                 | —                     | sections: Profile (notifications toggles), Integrations (Drive, Telegram, AI), Appearance(none yet), Danger zone                                                                                                                                                                                                 |
| Connect screens                       | Connect/Test          | per integration: status badge, certs never shown back (05 §4.6), Disconnect in overflow                                                                                                                                                                                                                          |

## 5. State Patterns (every list/detail handles all four)

| State                | Pattern                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Loading**          | Skeletons matching final layout (no spinners for initial load; spinners only for actions)                                              |
| **Empty**            | `EmptyState` with a single CTA that teaches the next step                                                                              |
| **Error (load)**     | inline panel: message + Retry button (never full-screen crash)                                                                         |
| **Partial/degraded** | `Banner` (e.g. Drive disconnected) + inline flags on affected records; greyed resume row says "Upload failed — applicant can resubmit" |

Forms: validate on blur, submit on explicit press only (no implicit mobile keyboard submit), disable submit while in-flight, preserve input on server error, first-invalid-field scroll focus.

## 6. Accessibility (WCAG 2.2 AA — tested per 13)

- Contrast ≥ 4.5:1 body text (tokens above comply — verify any new color).
- Full keyboard operability; visible focus ring (`:focus-visible` 2px brand).
- Labels on every input (no placeholder-as-label); errors announced via `aria-live="polite"`.
- Touch targets ≥44px; status pills also carry text (never color-only).
- Public apply page works with JS disabled down to a plain `<form>` POST (progressive enhancement).

## 7. Copy & Tone

- Plain words, imperative verbs for actions ("Create job", "Copy link", "Advance").
- Errors: `[what happened]. [what to do].` e.g. _"Couldn't reach Google Drive. Reconnect in Settings to receive resumes."_
- No toast spam: one toast per user action, max 2 queued; persistent info → Banner.
- Locale: English only Phase 0–4 (i18n-ready copy keys not required yet — noted as debt).

## 8. Performance Budgets (enforced in 13)

| Page                        | LCP (4G, mid-tier Android)   | JS (gz)           |
| --------------------------- | ---------------------------- | ----------------- |
| `/apply/[slug]`             | ≤ 2.0s                       | ≤ 60 KB route JS  |
| `/dashboard`                | ≤ 2.5s                       | ≤ 120 KB route JS |
| Interaction (status change) | optimistic < 100ms perceived | —                 |
