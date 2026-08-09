-- 0004_rls_and_triggers.sql
-- docs/04 §6 RLS (identity rule Phase 1–3: a row is visible iff owner_id = auth.uid(),
-- child tables join up). Org-membership policies are ADDED in 0006 (Phase 4) — additive, no rewrites.
-- Also: auth.users -> public.users profile trigger (docs/04 §5).

alter table public.users                enable row level security;
alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.jobs                 enable row level security;
alter table public.applicants           enable row level security;
alter table public.applications         enable row level security;
alter table public.resumes              enable row level security;
alter table public.tags                 enable row level security;
alter table public.applicant_tags       enable row level security;
alter table public.timeline_events      enable row level security;
alter table public.notes                enable row level security;
alter table public.integrations         enable row level security;
alter table public.settings             enable row level security;

-- users: self only
create policy users_self on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

-- organizations: owner manages; members can read (full role model in Phase 4 / 0006)
create policy organizations_owner  on public.organizations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy organizations_member_read on public.organizations
  for select using (exists (
    select 1 from public.organization_members m
    where m.organization_id = id and m.user_id = auth.uid()));

create policy organization_members_self_read on public.organization_members
  for select using (user_id = auth.uid());
create policy organization_members_org_owner on public.organization_members
  for all using (exists (
    select 1 from public.organizations o
    where o.id = organization_id and o.owner_id = auth.uid()));

-- owned tables: owner all
create policy jobs_owner on public.jobs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy applicants_owner on public.applicants
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy tags_owner on public.tags
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy integrations_owner on public.integrations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy settings_owner on public.settings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy timeline_owner on public.timeline_events
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy notes_owner on public.notes
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- child tables via parent joins
create policy applications_owner on public.applications
  for all using (exists (
    select 1 from public.jobs j where j.id = job_id and j.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.jobs j where j.id = job_id and j.owner_id = auth.uid()));

create policy resumes_owner on public.resumes
  for all using (exists (
    select 1 from public.applications a
      join public.jobs j on j.id = a.job_id
    where a.id = application_id and j.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.applications a
      join public.jobs j on j.id = a.job_id
    where a.id = application_id and j.owner_id = auth.uid()));

create policy applicant_tags_owner on public.applicant_tags
  for all using (exists (
    select 1 from public.applicants ap where ap.id = applicant_id and ap.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.applicants ap where ap.id = applicant_id and ap.owner_id = auth.uid()));

--------------------------------------------------------------------------------
-- NOTE: public apply writes (jobs lookup by slug, applicant/application insert)
-- bypass RLS ONLY via the service-role client inside /api/apply/:slug (docs/03 §Rules).
-- No anon/authenticated read of draft jobs is possible: anon has no policy grants here.

--------------------------------------------------------------------------------
-- docs/04 §5 — new auth user -> profile row
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
