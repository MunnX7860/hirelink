-- 0003_indexes.sql
-- docs/04 §4 performance + lookup indexes (extensions from 0001).

create index jobs_owner_status_idx       on public.jobs (owner_id, status);
create index applicants_owner_email_idx  on public.applicants (owner_id, email);
create index applications_job_status_idx on public.applications (job_id, status);
create index applications_applicant_idx  on public.applications (applicant_id);
create index applications_owner_feed_idx on public.applications (applied_at desc);  -- inbox feed
create index resumes_application_idx     on public.resumes (application_id);
create index timeline_app_idx            on public.timeline_events (application_id, created_at desc);
create index timeline_applicant_idx      on public.timeline_events (applicant_id, created_at desc);
create index notes_applicant_idx         on public.notes (applicant_id);

-- One active integration per (owner, type) — docs/04 §3.10.
create unique index integrations_one_active_per_type
  on public.integrations (owner_id, type) where status <> 'disconnected';

-- Phase 2 free-text search over applicant name+email (trigram).
create index applicants_search_trgm
  on public.applicants using gin ((full_name || ' ' || email) gin_trgm_ops);
