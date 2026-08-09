-- 0007_phase5_screening.sql
-- Phase 5 Smart Screening (docs/17, docs/04 §3.12). ADDITIVE ONLY — no rewrites,
-- no backfills (new columns land with inert defaults: no questionnaire configured,
-- no verdicts computed). Every statement is re-runnable.

--------------------------------------------------------------------------------
-- 1. Questionnaire (PRIVATE rules, 17 §3.4) + deterministic verdict column
--------------------------------------------------------------------------------
alter table public.jobs
  add column if not exists screening_config jsonb not null default '{"questions":[]}'::jsonb;

alter table public.applications
  add column if not exists screening_status text
  check (screening_status in ('qualified','does_not_meet_mandatory','review_required'));
-- NULL = no mandatory questions configured (feature effectively off for the job).

-- timeline journaling for screening outcomes (append-only enum extension, 04 §7 note)
alter type public.timeline_event_type add value if not exists 'questionnaire_screened';

--------------------------------------------------------------------------------
-- 2. application_answers — candidate PII, one row per question (17 §2)
--------------------------------------------------------------------------------
create table if not exists public.application_answers (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  applicant_id   uuid not null references public.applicants(id)    on delete cascade,
  question_id    text not null,                    -- nanoid-6 from screening_config
  answer         jsonb not null,                   -- typed payload per question type
  created_at     timestamptz not null default now(),
  unique (application_id, question_id)
);
create index if not exists answers_application_idx on public.application_answers (application_id);
alter table public.application_answers enable row level security;

-- read: owner via applicant; members via current_org_role (17 §10 / 04 §6 pattern).
drop policy if exists answers_owner_read on public.application_answers;
create policy answers_owner_read on public.application_answers
  for select using (exists (
    select 1 from public.applicants ap where ap.id = applicant_id and ap.owner_id = auth.uid()));
drop policy if exists answers_org_read on public.application_answers;
create policy answers_org_read on public.application_answers
  for select using (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null));
-- writes: service-role client only (public apply path) — no user policies by design.

--------------------------------------------------------------------------------
-- 3. applicant_profiles — parse-v2 cache (17 §6), 1:1 with applicant
--------------------------------------------------------------------------------
create table if not exists public.applicant_profiles (
  applicant_id     uuid primary key references public.applicants(id) on delete cascade,
  payload          jsonb not null,                  -- ResumeProfileSchema
  source_resume_id uuid references public.resumes(id) on delete set null,
  prompt_version   text not null,
  updated_at       timestamptz not null default now()
);
alter table public.applicant_profiles enable row level security;

drop trigger if exists applicant_profiles_updated_at on public.applicant_profiles;
create trigger applicant_profiles_updated_at before update on public.applicant_profiles
  for each row execute procedure public.set_updated_at();

drop policy if exists applicant_profiles_owner on public.applicant_profiles;
create policy applicant_profiles_owner on public.applicant_profiles
  for all using (exists (
    select 1 from public.applicants ap where ap.id = applicant_id and ap.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.applicants ap where ap.id = applicant_id and ap.owner_id = auth.uid()));
drop policy if exists applicant_profiles_org on public.applicant_profiles;
create policy applicant_profiles_org on public.applicant_profiles
  for all using (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null))
  with check (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null));

--------------------------------------------------------------------------------
-- 4. ai_screening_sessions — append-only history (17 §7)
--------------------------------------------------------------------------------
create table if not exists public.ai_screening_sessions (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  owner_id        uuid not null references public.users(id),        -- creator
  organization_id uuid references public.organizations(id),         -- denormalized from job (RLS/indexes)
  pool            text not null check (pool in ('qualified','review_required','qualified_review','all_non_archived')),
  instruction     text not null check (char_length(instruction) between 3 and 2000),
  max_results     integer not null check (max_results between 1 and 100),
  provider        text not null default 'gemini',
  model           text not null,
  prompt_version  text not null,
  engine          text not null default 'interactive' check (engine in ('interactive','batch')),
  engine_ref      text,                                             -- e.g. Gemini batch resource name
  status          text not null default 'queued'
                  check (status in ('queued','processing','completed','failed','cancelled','quota_limited')),
  pool_size       integer not null default 0,
  processed       integer not null default 0,
  failed          integer not null default 0,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists screening_sessions_job_idx
  on public.ai_screening_sessions (job_id, created_at desc);
alter table public.ai_screening_sessions enable row level security;

-- owner via job join; org members via denormalized organization_id (mirrors jobs_org_member).
drop policy if exists screening_sessions_owner on public.ai_screening_sessions;
create policy screening_sessions_owner on public.ai_screening_sessions
  for all using (exists (
    select 1 from public.jobs j where j.id = job_id and j.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.jobs j where j.id = job_id and j.owner_id = auth.uid()));
drop policy if exists screening_sessions_org on public.ai_screening_sessions;
create policy screening_sessions_org on public.ai_screening_sessions
  for all using (public.current_org_role(organization_id) is not null)
  with check (public.current_org_role(organization_id) is not null);

--------------------------------------------------------------------------------
-- 5. ai_screening_results — retry unit = one row (17 §8/§9.3)
--------------------------------------------------------------------------------
create table if not exists public.ai_screening_results (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.ai_screening_sessions(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  applicant_id   uuid not null references public.applicants(id)   on delete cascade,
  status         text not null default 'pending' check (status in ('pending','ok','failed')),
  error          text,
  rank           integer,
  category       text check (category in ('strong_match','possible_match','review_required','lower_priority')),
  score          smallint check (score between 0 and 100),        -- AI prioritization score — NOT a probability (17 §8.1)
  reasons        jsonb not null default '[]'::jsonb,
  evidence       jsonb not null default '[]'::jsonb,
  uncertainties  jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  unique (session_id, application_id)
);
create index if not exists screening_results_session_idx
  on public.ai_screening_results (session_id, status, rank);
alter table public.ai_screening_results enable row level security;

drop policy if exists screening_results_owner on public.ai_screening_results;
create policy screening_results_owner on public.ai_screening_results
  for all using (exists (
    select 1 from public.ai_screening_sessions s
      join public.jobs j on j.id = s.job_id
    where s.id = session_id and j.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.ai_screening_sessions s
      join public.jobs j on j.id = s.job_id
    where s.id = session_id and j.owner_id = auth.uid()));
drop policy if exists screening_results_org on public.ai_screening_results;
create policy screening_results_org on public.ai_screening_results
  for all using (exists (
    select 1 from public.ai_screening_sessions s
    where s.id = session_id and public.current_org_role(s.organization_id) is not null))
  with check (exists (
    select 1 from public.ai_screening_sessions s
    where s.id = session_id and public.current_org_role(s.organization_id) is not null));

--------------------------------------------------------------------------------
-- 6. Verdict listing index (screening tab counters, pool queries — 17 §9)
--------------------------------------------------------------------------------
create index if not exists applications_job_screening_idx
  on public.applications (job_id, screening_status);
