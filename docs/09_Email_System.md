# 09 — Email System

> Last updated 2026-08-07. Normative. D4 applies: email failure never blocks flows. Template-based architecture from day one.

## 1. Provider & Transport

|           |                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Provider  | **Gmail SMTP** (`GMAIL_USER` + `GMAIL_APP_PASSWORD`) → **Resend** (`RESEND_API_KEY`) → null-transport, in that precedence |
| From      | `EMAIL_FROM` = `notifications@<our-domain>` — display name configurable: `"{Owner/Company name} via HireLink"`            |
| Templates | **react-email** components in `src/emails/`, rendered server-side to HTML + auto plaintext                                |
| Sending   | `lib/notifications/email.ts` behind `NotificationService.sendApplicantConfirmation` etc.                                  |
| Env-gate  | Neither configured (local dev) → `null`-transport: render + log, mark `email_sent` event with `"simulated": true`         |

**Transport precedence** is resolved per-send in `sendEmail()`: Gmail SMTP wins when both are set. Only one need be configured; `features.email` is true if either is.

**Gmail SMTP** (`smtp.gmail.com:465`, `nodemailer`): the password is a Google **App Password**, which requires 2-Step Verification on the account — never the account password. Caveats that shaped the implementation:

- Gmail **rewrites the From address** to the authenticated account unless a verified "Send mail as" alias matches. `buildFromHeader()` therefore takes an `addressOverride` and the Gmail path passes `GMAIL_USER`: only `EMAIL_FROM`'s _display name_ survives, and the header never claims an address recipients won't actually see.
- **500 sends/day** on consumer Gmail (2,000 on Workspace). Permanent 5xx rejections are not retried — retrying only burns quota. 421 and 45x (including throttling) are retryable.
- **No bounce webhooks.** The Resend webhook path (`POST /api/webhooks/resend`, §Bounces) is dead while Gmail is the active transport; bounces land in the sending mailbox instead.
- 15s connection/greeting/socket timeouts so one hung dial can't stall the route's `after()` block.

Why Resend remains the documented default for scale: per-message status webhooks, DKIM/SPF on our own domain, and no daily cap. Gmail is the zero-setup path for a solo owner who has not verified a domain.

## 2. Email Catalogue (template registry)

| Template id            | Audience  | Trigger                                                                                                | Phase      |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `application_received` | Applicant | Application created (`users.notify_applicant_email = true`) **and the candidate qualified** — see §2.2 | 1          |
| `owner_resume_failed`  | Owner     | Drive upload failed after retries                                                                      | 1          |
| `interview_invitation` | Applicant | Owner hits "Invite" on `interview` status (manual action)                                              | **future** |
| `rejection`            | Applicant | Owner sends (opt-in, never automatic on status change)                                                 | **future** |

Registration pattern: `src/emails/registry.ts` maps `template_id → { component, subject(ctx), required_vars[] }`; `sendEmail({ to, template, ctx })` type-checks ctx against the registry — a template cannot render without its declared variables.

### 2.1 `application_received` (the one that ships in Phase 1)

- **Subject:** `Application received — {job_title}`
- **Body:** greeting by first name → confirmation of application to `{job_title}` → "The employer will review your application" → support footer. **No** links back to us that expect auth; no resume content attached.
- **Ctx:** `{ candidate_first_name, job_title, company_label }` (company_label = owner full name Phase 1, org brand name Phase 4).
- Delivered via `ApplicationsService` per 03 §5 with one retry; outcome → `email_sent` / `email_failed` timeline events (08 shares this pattern).

### 2.2 Screening gate on `application_received` (normative)

The confirmation is sent **only to candidates who qualified**. The apply route computes the deterministic verdict (`evaluateScreening`, pure) before notifying:

| `screening_status`        | Emailed? | Rationale                                                                            |
| ------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `null`                    | **yes**  | Job has no mandatory questionnaire — no verdict exists to gate on; Phase 1 behaviour |
| `qualified`               | **yes**  | Passed every mandatory rule                                                          |
| `review_required`         | no       | Ambiguous/incomplete answer — owner decides, so the app must not imply acceptance    |
| `does_not_meet_mandatory` | no       | Clear mandatory-requirement failure                                                  |

A suppressed send writes an **`email_skipped`** timeline event (migration 0012) carrying `{ to: 'applicant', template, reason }`. This is deliberate: without it the timeline is silent for those applicants and an intentional policy skip is indistinguishable from a delivery failure. No send is attempted — `email_skipped` is never a fallback for `email_failed`.

Consequence worth stating plainly: non-qualifying applicants receive **no acknowledgement at all** that their application arrived. That is the chosen behaviour, not an oversight; revisit if candidate experience outweighs inbox volume.

## 3. Template Authoring Rules

- Mobile-first table layout, inline styles via react-email `<Tailwind>` or inline style objects; max width 520px; 16px base; system font stack (06 §2).
- Every email has plaintext auto-derived and a one-line preheader.
- No remote images in Phase 1–3 (opens aren't tracked — we don't spy on applicants); logo optional Phase 4 branding (CID attachment via 11 §Branding).
- User-supplied strings are **never** interpolated into HTML unsanitized (react-email escapes by default — keep it that way; no `dangerouslySetInnerHTML` in templates).
- i18n: English templates now; registry keyed by `(template_id, locale)` so translation is additive later.

## 4. Deliverability & Compliance

- DNS (per 12 §Checklist): SPF + DKIM + DMARC records from Resend domain setup; test with mail-tester before prod.
- Bounces/complaints: webhook `POST /api/webhooks/resend` (Phase 2) flips `email_failed` events; hard bounce → mark communication bad in event payload (we keep contacts usable since applicants re-apply rarely).
- Legal: footer always shows sender identity + "You received this because you applied to {job_title}". No marketing email surface exists — all mail is **transactional**; adding marketing email would require explicit consent columns (not planned).
- Rate limits: Resend free 100/day is plenty Phase 1; alert via Sentry on 429 spikes.

## 5. Failure Semantics (mirror of 08 §4)

8s timeout → 1 retry (5s) → `email_failed` timeline event with provider error code. Applicant-facing flows already succeeded (they saw the success screen); email is a courtesy copy. Owner-facing degradation shows in Settings → Integrations → Email status.

## 6. Testing

- Unit: registry ctx type tests, subject builders, plaintext renderer snapshot per template.
- Integration: Resend in "test mode" key on CI (env `RESEND_API_KEY= re_test_…`) asserting payload shape without real delivery.
- E2E apply flow asserts `sendApplicantConfirmation` invoked once (mock transport) and `email_sent` event written.
- Manual: send to real inbox (Gmail/Outlook/Apple Mail) visual pass before each release with template changes (13 §Release QA).
