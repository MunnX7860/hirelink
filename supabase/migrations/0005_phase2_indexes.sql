-- 0005_phase2_indexes.sql
-- Phase 2 (docs/04 §4): free-text trigram search + notes lookup index.
-- pg_trgm extension itself ships in 0001.

create index if not exists notes_applicant_idx
  on public.notes (applicant_id);

create index if not exists applicants_search_trgm
  on public.applicants using gin ((full_name || ' ' || email) gin_trgm_ops);

-- Application deletion journaling (docs/05 §4.3 DELETE). Enum extension is
-- append-only and non-reversible — flagged per docs/04 §1.
alter type public.timeline_event_type add value if not exists 'application_deleted';
