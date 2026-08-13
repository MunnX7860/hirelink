-- 0012_email_skipped_event.sql
-- Adds `email_skipped` to timeline_event_type (docs/09 §2).
--
-- Applicant confirmation emails are now gated on the screening verdict: only
-- `qualified` candidates (and applicants to jobs with no mandatory questionnaire,
-- where there is no verdict to gate on) receive one. Candidates who land in
-- `does_not_meet_mandatory` or `review_required` are deliberately NOT emailed.
--
-- Without this event the timeline would be silent for those applicants, making
-- "why did this candidate never hear from us?" indistinguishable from a genuine
-- delivery failure. `email_skipped` records the deliberate decision and its
-- reason, so the audit trail stays complete.
--
-- ADDITIVE, re-runnable (`add value if not exists`) — same pattern as 0005/0007.

alter type public.timeline_event_type add value if not exists 'email_skipped';
