# 01 — Product Vision

> Last updated 2026-08-07. Parent: `00_Master_PRD.md`.

## 1. Mission

**Build the simplest mobile-first hiring and talent CRM platform for businesses hiring through social media.**

"Simplest" is the operative word. Every feature request is filtered through: _does this make posting a job link and processing applicants faster for a non-technical owner on a phone?_ If not, it waits.

## 2. Vision Narrative

Hiring for small businesses today starts where their audience already is — Instagram stories, WhatsApp groups, Telegram channels, Facebook pages. The tooling, however, starts on a desktop with a 14-day trial and a demo call. The gap between "posting a story" and "tracking 40 applicants" is filled today with DMs, screenshots, and spreadsheets.

HireLink closes that gap with a single loop:

> **Create link → Share anywhere → Applicants flow in → Everything (resumes, pipeline, notifications) is organised automatically.**

The product deliberately grows **with** the user:

- Today they are one person hiring for one role → **personal hiring tool** (Phase 1).
- They accumulate people → **talent CRM** with tags, notes, pipeline (Phase 2).
- They want speed → **AI** parses resumes and drafts job posts, with their own key (Phase 3).
- They become a team or an agency → **SaaS** with organizations and branding (Phase 4).

No re-platforming, no data migration surprises for the user — the architecture (from day one) already carries `organization_id` everywhere (see D5, Master PRD).

## 3. Positioning

|                            | Enterprise ATS (Greenhouse, Lever) | Form tools (Google Forms, Typeform)  | **HireLink**                   |
| -------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------ |
| Setup time                 | Days–weeks                         | Minutes                              | **Minutes**                    |
| Mobile-first               | No                                 | Partial                              | **Yes**                        |
| Pipeline / CRM             | Heavy                              | None                                 | **Lightweight, just enough**   |
| Resumes where you own them | Their cloud                        | Your Drive (forms only, unorganised) | **Your Drive, auto-organised** |
| Instant Telegram alerts    | No                                 | No                                   | **Yes**                        |
| Price posture              | $$$ per seat                       | Free/cheap                           | Free tier → affordable SaaS    |

We are not an ATS replacement. We are the **smallest possible system of record** for social-media hiring.

## 4. Target Users

1. **Small businesses** hiring 1–50 roles/year from their own audience (restaurants, salons, clinics, agencies, D2C, local services).
2. **Solo recruiters** running lightweight hiring for SMB clients.
3. **HR teams** (Phase 4) of SMBs wanting a shared, branded pipeline without enterprise cost.

## 5. Core Principles

| Principle        | Meaning in practice                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fast**         | Link creation < 2 min; apply flow < 3 min; dashboard p75 load < 1.5s on 4G; notifications < 60s.                                               |
| **Mobile-first** | 360px design baseline; thumb-reach primary actions; works as installable PWA.                                                                  |
| **AI optional**  | 100% of core flows work with zero AI keys configured. AI strictly accelerates (parsing, drafting). See 10.                                     |
| **Modular**      | Storage, notifications, AI are swappable providers behind interfaces (03 §Modules). Features ship independently per roadmap.                   |
| **Secure**       | RLS everywhere, minimal OAuth scopes, AES-256-GCM encrypted credentials, no public resume URLs, HTTPS-only.                                    |
| **Easy to use**  | Minimal fields, one primary action per screen, sensible defaults (resume required, phone optional), zero-config notifications until connected. |

## 6. Experience Vision (what "great" looks like)

- An owner creates their first job while standing in their shop, gets the link, and posts it to their WhatsApp status — all from a phone, in one sitting.
- An applicant on 3G opens the link, the form renders instantly, resume upload shows clear progress, and a confirmation email arrives before they close the tab.
- The owner feels a Telegram buzz per applicant and can triage 20 applications into _shortlisted / rejected_ in two minutes of thumb-work.
- Nothing ever says "something went wrong, your application was lost." The system degrades visibly and retries (03 §Resilience).

## 7. Success Metrics

| Level      | Metric                                          | Target          |
| ---------- | ----------------------------------------------- | --------------- |
| North Star | Applications successfully processed / week      | Grow MoM        |
| Activation | New users creating ≥1 hiring link in 24h        | > 60%           |
| Engagement | Weekly active hiring users (≥1 pipeline action) | —               |
| Quality    | Submission success rate / notification delivery | ≥ 99.5% / ≥ 99% |
| Speed      | Median time: signup → first applicant received  | < 24h           |
| Phase 3    | AI attach rate (users with ≥1 AI action/week)   | ≥ 25%           |

## 8. What We Will NOT Do (vision constraints)

- No candidate marketplace or job aggregation — distribution is the owner's social reach.
- No desktop-only power features; density must never compromise mobile clarity.
- No selling/locking user data — files in _their_ Drive, export always available, deletion honoured (07 §Disconnect).
- No platform-paid AI — BYOK only, so "AI optional" is also a business-model guarantee, not just architecture (10).
