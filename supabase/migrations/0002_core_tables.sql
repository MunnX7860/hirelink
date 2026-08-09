-- 0002_core_tables.sql
-- docs/04 §3. Every owned table carries owner_id (Phase 1–3) AND nullable organization_id (Phase 4 backfill, D5).
-- Unique indexes that are lookup-enforcement live here; performance indexes live in 0003.

--------------------------------------------------------------------------------
-- 3.1 users — profile, mirrors auth.users (populated by trigger in 0004)
create table public.users (
  id                     uuid primary key references auth.users(id) on delete cascade,
  email                  text not null,
  full_name              text,
  avatar_url             text,
  default_organization_id uuid,                     -- Phase 4 FK added in 0006
  notify_telegram        boolean not null default true,
  notify_applicant_email boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- 3.2 organizations — created in v1, activated Phase 4
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 2 and 120),
  slug       text not null unique,                    -- nanoid(10)
  owner_id   uuid not null references public.users(id),
  brand      jsonb not null default '{}'::jsonb,      -- { logo_url, primary_color, email_from_name }
  plan       text not null default 'free' check (plan in ('free','pro','team')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id)       on delete cascade,
  role            member_role not null default 'owner',
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

--------------------------------------------------------------------------------
-- 3.3 jobs
create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.users(id) on delete cascade,
  organization_id uuid references public.organizations(id),          -- null = personal workspace
  title           text not null check (char_length(title) between 3 and 120),
  description     text not null default '' check (char_length(description) <= 5000),
  slug            text not null unique,                              -- nanoid(8) a-z0-9
  status          job_status not null default 'draft',
  form_config     jsonb not null default
    '{"phone":"optional","resume":"required","cover_note":"hidden"}'::jsonb,
  drive_folder_id text,                                             -- cached after ensureJobFolder
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on column public.jobs.form_config is
  'Per-field visibility: each of phone|resume|cover_note = required|optional|hidden. name & email always required.';

--------------------------------------------------------------------------------
-- 3.4 applicants — deduped people (talent pool)
create table public.applicants (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.users(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  full_name       text not null check (char_length(full_name) between 2 and 200),
  email           citext not null,
  phone           text,
  source          text not null default 'direct',
  ai_summary      text,                                             -- Phase 3 cache
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_id, email)
);

--------------------------------------------------------------------------------
-- 3.5 applications
create table public.applications (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs(id)        on delete cascade,
  applicant_id   uuid not null references public.applicants(id)  on delete cascade,
  status         application_status not null default 'new',
  source_meta    jsonb not null default '{}'::jsonb,             -- { utm_*, referrer, user_agent }
  applied_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (job_id, applicant_id)                                  -- D8 idempotency
);

--------------------------------------------------------------------------------
-- 3.6 resumes — file references, NOT files (D2)
create table public.resumes (
  id                uuid primary key default gen_random_uuid(),
  application_id    uuid not null references public.applications(id) on delete cascade,
  applicant_id      uuid not null references public.applicants(id)   on delete cascade,
  storage_provider  text not null default 'google_drive',
  storage_file_id   text,                                            -- Drive file id; null while failed
  original_filename text not null,
  mime_type         text not null,
  size_bytes        integer not null check (size_bytes between 1 and 10485760),  -- ≤ 10 MB
  upload_status     upload_status not null default 'uploaded',
  parsed_text       text,                                            -- Phase 3 extraction cache
  ai_parsed         jsonb,                                           -- Phase 3 ParsedResume
  created_at        timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- 3.7 tags + applicant_tags (Phase 2; schema now)
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  color      text not null default '#6366f1',
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table public.applicant_tags (
  applicant_id uuid not null references public.applicants(id) on delete cascade,
  tag_id       uuid not null references public.tags(id)       on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (applicant_id, tag_id)
);

--------------------------------------------------------------------------------
-- 3.8 timeline_events — unified audit + activity feed
create table public.timeline_events (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.users(id) on delete cascade,
  applicant_id   uuid references public.applicants(id)   on delete cascade,
  application_id uuid references public.applications(id) on delete cascade,
  actor_id       uuid references public.users(id),              -- null = system/applicant
  type           timeline_event_type not null,
  payload        jsonb not null default '{}'::jsonb,            -- e.g. status_changed: { from, to }
  created_at     timestamptz not null default now(),
  check (applicant_id is not null or application_id is not null)
);

--------------------------------------------------------------------------------
-- 3.9 notes
create table public.notes (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.users(id) on delete cascade,
  applicant_id   uuid not null references public.applicants(id)   on delete cascade,
  application_id uuid references public.applications(id)          on delete cascade,
  author_id      uuid not null references public.users(id),
  body           text not null check (char_length(body) between 1 and 5000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- 3.10 integrations — encrypted per-owner connections
create table public.integrations (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.users(id) on delete cascade,
  organization_id       uuid references public.organizations(id),
  type                  integration_type not null,
  status                integration_status not null default 'active',
  credentials_encrypted text,                       -- AES-256-GCM v1.iv.tag.ct (D3); null for config-only
  config                jsonb not null default '{}'::jsonb,       -- e.g. { root_folder_id } or { chat_id }
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

--------------------------------------------------------------------------------
-- 3.11 settings — sparse key/value per owner
create table public.settings (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  unique (owner_id, key)
);

--------------------------------------------------------------------------------
-- §5 updated_at maintenance
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger users_updated_at         before update on public.users         for each row execute procedure public.set_updated_at();
create trigger jobs_updated_at          before update on public.jobs          for each row execute procedure public.set_updated_at();
create trigger organizations_updated_at before update on public.organizations for each row execute procedure public.set_updated_at();
create trigger applicants_updated_at    before update on public.applicants    for each row execute procedure public.set_updated_at();
create trigger applications_updated_at  before update on public.applications  for each row execute procedure public.set_updated_at();
create trigger notes_updated_at         before update on public.notes         for each row execute procedure public.set_updated_at();
create trigger integrations_updated_at  before update on public.integrations  for each row execute procedure public.set_updated_at();
create trigger settings_updated_at      before update on public.settings      for each row execute procedure public.set_updated_at();
