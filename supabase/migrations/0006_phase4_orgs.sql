-- 0006_phase4_orgs.sql
-- Phase 4 activation (docs/11 §5–§7, docs/04 §6). ADDITIVE ONLY — no rewrites, zero data movement.
-- Every statement is re-runnable (guards or `if not exists`/`or replace`) so the rehearsal +
-- the standalone runner (scripts/backfill-orgs.mjs) can be executed more than once safely.
--
-- Contents:
--   1. organizations.deleted_at (soft-delete, 11 §7) + FK users.default_organization_id
--   2. organization_invites (SHA-256-hashed tokens, 7d expiry, single use)
--   3. tags.organization_id (team tags) + per-scope unique indexes + org dedupe/listing indexes
--   4. helper functions: current_org_role / lookup_invite / accept_org_invite (security definer)
--   5. additive org RLS policies (current_org_role is the single gate — inert once deleted_at is set)
--   6. personal-org backfill: "{Name}'s workspace" shell per existing user (membership only;
--      data rows stay organization_id IS NULL; default_organization_id NOT touched)

--------------------------------------------------------------------------------
-- 1. Soft-delete + default-org FK
--------------------------------------------------------------------------------
alter table public.organizations add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_default_organization_fk') then
    alter table public.users
      add constraint users_default_organization_fk
      foreign key (default_organization_id) references public.organizations(id) on delete set null;
  end if;
end $$;

--------------------------------------------------------------------------------
-- 2. organization_invites — raw tokens never stored (11 §7)
--------------------------------------------------------------------------------
create table if not exists public.organization_invites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email           citext not null,
  role            member_role not null default 'member'
                  check (role in ('admin','member')),        -- owner is never invitable (11 §2)
  token_hash      text not null unique,                      -- sha256 hex of the 24-char nanoid
  invited_by      uuid not null references public.users(id),
  expires_at      timestamptz not null,                      -- created + interval '7 days'
  accepted_at     timestamptz,                               -- single use
  created_at      timestamptz not null default now()
);
create index if not exists invites_org_pending_idx
  on public.organization_invites (organization_id) where accepted_at is null;
alter table public.organization_invites enable row level security;

--------------------------------------------------------------------------------
-- 3. Team tags + org indexes (docs/04 §3.7/§4)
--------------------------------------------------------------------------------
alter table public.tags add column if not exists organization_id uuid references public.organizations(id);

create unique index if not exists tags_org_name_uniq
  on public.tags (organization_id, lower(name)) where organization_id is not null;
create unique index if not exists applicants_org_email_uniq
  on public.applicants (organization_id, email) where organization_id is not null;
create index if not exists jobs_org_status_idx
  on public.jobs (organization_id, status) where organization_id is not null;
create index if not exists applicants_org_created_idx
  on public.applicants (organization_id, created_at desc) where organization_id is not null;
create index if not exists integrations_org_type_idx
  on public.integrations (organization_id, type) where organization_id is not null;

--------------------------------------------------------------------------------
-- 4. Helper functions (security definer — bypass RLS internally to avoid policy
--    recursion on organization_members; they still key off auth.uid()).
--------------------------------------------------------------------------------

-- Single gate for every org policy below. Returns null for non-members AND for
-- soft-deleted orgs — which makes all org policies inert the instant an org is deleted (11 §7).
create or replace function public.current_org_role(org uuid)
returns member_role
language sql stable security definer set search_path = public as $$
  select m.role
  from public.organization_members m
    join public.organizations o on o.id = m.organization_id
  where m.organization_id = org
    and m.user_id = auth.uid()
    and o.deleted_at is null
  limit 1
$$;

-- Peek for the invite accept screen (docs/05 §4.9): exists-only semantics — unknown,
-- expired or consumed tokens all raise P0002 'invite_expired' (no existence leak).
create or replace function public.lookup_invite(p_token text)
returns table(org_name text, role member_role, inviter_name text, email citext, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return query
    select o.name, i.role, u.full_name, i.email, i.expires_at
    from public.organization_invites i
      join public.organizations o on o.id = i.organization_id and o.deleted_at is null
      left join public.users u on u.id = i.invited_by
    where i.token_hash = encode(digest(p_token, 'sha256'), 'hex')
      and i.accepted_at is null
      and i.expires_at > now();
  if not found then
    raise exception 'invite_expired' using errcode = 'P0002';
  end if;
end $$;

-- Atomic accept (docs/05 §4.9, 11 §2): validates the session email, enforces the plan
-- seat cap under an org-row lock (plan→cap mapping mirrored from lib/plans.ts — keep in
-- sync: free 1 / pro 3 / team 25), inserts the membership idempotently, consumes this
-- invite, clears sibling pending invites for the same (org, email), and defaults the
-- user's workspace to the org when unset.
-- Seats accounting (11 §4): members + other pending invites both reserve seats.
create or replace function public.accept_org_invite(p_token text)
returns table(org_id uuid, org_name text, role member_role, already_member boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.organization_invites%rowtype;
  v_email  citext;
  v_uid    uuid := auth.uid();
  v_used   integer;
  v_cap    integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select au.email into v_email from auth.users au where au.id = v_uid;

  select i.* into v_invite
  from public.organization_invites i
    join public.organizations o on o.id = i.organization_id and o.deleted_at is null
  where i.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and i.accepted_at is null
    and i.expires_at > now();
  if not found then
    raise exception 'invite_expired' using errcode = 'P0002';
  end if;

  if lower(v_email::text) <> lower(v_invite.email::text) then
    raise exception 'email_mismatch' using errcode = 'P0001';
  end if;

  already_member := exists (
    select 1 from public.organization_members m
    where m.organization_id = v_invite.organization_id and m.user_id = v_uid
  );

  if not already_member then
    -- Lock the org row so concurrent accepts can't race past the seat cap.
    select case o.plan when 'pro' then 3 when 'team' then 25 else 1 end into v_cap
    from public.organizations o where o.id = v_invite.organization_id for update;
    select (select count(*) from public.organization_members m where m.organization_id = v_invite.organization_id)
         + (select count(*) from public.organization_invites p
             where p.organization_id = v_invite.organization_id and p.accepted_at is null and p.id <> v_invite.id)
      into v_used;
    if v_used + 1 > v_cap then
      raise exception 'seats_exceeded' using errcode = 'P0003';
    end if;
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_invite.organization_id, v_uid, v_invite.role)
  on conflict do nothing;

  update public.organization_invites set accepted_at = now() where id = v_invite.id;
  delete from public.organization_invites
  where organization_id = v_invite.organization_id
    and email = v_invite.email
    and id <> v_invite.id
    and accepted_at is null;

  update public.users u set default_organization_id = v_invite.organization_id
  where u.id = v_uid and u.default_organization_id is null;

  select o.name into org_name from public.organizations o where o.id = v_invite.organization_id;
  org_id := v_invite.organization_id;
  role := v_invite.role;
  return next;
end $$;

revoke execute on function public.lookup_invite(text) from public, anon;
revoke execute on function public.accept_org_invite(text) from public, anon;
grant execute on function public.lookup_invite(text) to authenticated;
grant execute on function public.accept_org_invite(text) to authenticated;

--------------------------------------------------------------------------------
-- 5. Additive org RLS policies (docs/11 §5). drop-policy-then-create so this file
--    is re-runnable without pg_policy guard blocks everywhere.
--------------------------------------------------------------------------------

-- organizations: admins may update (rename); org owner already covered by 0004 owner policy.
drop policy if exists organizations_org_admin on public.organizations;
create policy organizations_org_admin on public.organizations
  for update using (public.current_org_role(id) in ('owner','admin'))
  with check (public.current_org_role(id) in ('owner','admin'));

-- users: co-members can read the roster (names/emails for member lists, docs/05 §4.9).
drop policy if exists users_org_roster on public.users;
create policy users_org_roster on public.users
  for select using (
    id = auth.uid()
    or exists (
      select 1 from public.organization_members me
        join public.organization_members them
          on them.organization_id = me.organization_id and them.user_id = public.users.id
      where me.user_id = auth.uid()
    )
  );

-- organization_members: members read the roster; owner/admin manage it.
drop policy if exists organization_members_org_read on public.organization_members;
create policy organization_members_org_read on public.organization_members
  for select using (public.current_org_role(organization_id) is not null);
drop policy if exists organization_members_org_manage on public.organization_members;
create policy organization_members_org_manage on public.organization_members
  for all using (public.current_org_role(organization_id) in ('owner','admin'))
  with check (public.current_org_role(organization_id) in ('owner','admin'));

-- organization_invites: admin+ manage (accept path runs through security-definer RPC).
drop policy if exists invites_org_manage on public.organization_invites;
create policy invites_org_manage on public.organization_invites
  for all using (public.current_org_role(organization_id) in ('owner','admin'))
  with check (public.current_org_role(organization_id) in ('owner','admin'));

-- jobs
drop policy if exists jobs_org_member on public.jobs;
create policy jobs_org_member on public.jobs
  for all using (public.current_org_role(organization_id) is not null)
  with check (public.current_org_role(organization_id) is not null);

-- applicants
drop policy if exists applicants_org_member on public.applicants;
create policy applicants_org_member on public.applicants
  for all using (public.current_org_role(organization_id) is not null)
  with check (public.current_org_role(organization_id) is not null);

-- tags
drop policy if exists tags_org_member on public.tags;
create policy tags_org_member on public.tags
  for all using (public.current_org_role(organization_id) is not null)
  with check (public.current_org_role(organization_id) is not null);

-- integrations: members read status rows; owner/admin manage.
drop policy if exists integrations_org_read on public.integrations;
create policy integrations_org_read on public.integrations
  for select using (public.current_org_role(organization_id) is not null);
drop policy if exists integrations_org_manage on public.integrations;
create policy integrations_org_manage on public.integrations
  for all using (public.current_org_role(organization_id) in ('owner','admin'))
  with check (public.current_org_role(organization_id) in ('owner','admin'));

-- applications / resumes via job parent join
drop policy if exists applications_org_member on public.applications;
create policy applications_org_member on public.applications
  for all using (exists (
    select 1 from public.jobs j
    where j.id = job_id and public.current_org_role(j.organization_id) is not null))
  with check (exists (
    select 1 from public.jobs j
    where j.id = job_id and public.current_org_role(j.organization_id) is not null));

drop policy if exists resumes_org_member on public.resumes;
create policy resumes_org_member on public.resumes
  for all using (exists (
    select 1 from public.applications a
      join public.jobs j on j.id = a.job_id
    where a.id = application_id and public.current_org_role(j.organization_id) is not null))
  with check (exists (
    select 1 from public.applications a
      join public.jobs j on j.id = a.job_id
    where a.id = application_id and public.current_org_role(j.organization_id) is not null));

-- applicant_tags via applicant parent join
drop policy if exists applicant_tags_org_member on public.applicant_tags;
create policy applicant_tags_org_member on public.applicant_tags
  for all using (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null))
  with check (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null));

-- notes: members read org applicant notes; writes stay self-owned (0004 owner policy
-- already allows update/delete of one's own notes).
drop policy if exists notes_org_read on public.notes;
create policy notes_org_read on public.notes
  for select using (exists (
    select 1 from public.applicants ap
    where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null));
drop policy if exists notes_org_insert on public.notes;
create policy notes_org_insert on public.notes
  for insert with check (
    owner_id = auth.uid() and author_id = auth.uid() and exists (
      select 1 from public.applicants ap
      where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null));

-- timeline_events: org READ only (writes stay owner_id = actor — unified feed shows
-- each member's own actions plus all activity on org entities).
drop policy if exists timeline_org_read on public.timeline_events;
create policy timeline_org_read on public.timeline_events
  for select using (
    exists (
      select 1 from public.applicants ap
      where ap.id = applicant_id and public.current_org_role(ap.organization_id) is not null)
    or exists (
      select 1 from public.applications a
        join public.jobs j on j.id = a.job_id
      where a.id = application_id and public.current_org_role(j.organization_id) is not null));

--------------------------------------------------------------------------------
-- 6. Personal-org backfill — shell + owner membership per existing user.
--    Idempotent (membership guard). DATA ROWS ARE NOT TOUCHED (11 §6.1):
--    existing jobs/applicants/tags/integrations stay organization_id IS NULL and
--    users.default_organization_id stays unset (personal remains the default view).
--------------------------------------------------------------------------------
do $$
declare
  u record;
  v_org uuid;
  v_name text;
begin
  for u in select id, email, full_name from public.users loop
    if exists (
      select 1 from public.organization_members m
      where m.user_id = u.id and m.role = 'owner'
    ) then
      continue;
    end if;
    v_name := left(
      coalesce(nullif(btrim(u.full_name), ''), split_part(u.email, '@', 1)) || '''s workspace',
      120
    );
    loop
      begin
        insert into public.organizations (name, slug, owner_id)
        values (v_name, lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 10)), u.id)
        returning id into v_org;
        exit;
      exception when unique_violation then
        -- Astronomically unlikely slug collision — retry with fresh randomness.
      end;
    end loop;
    insert into public.organization_members (organization_id, user_id, role)
    values (v_org, u.id, 'owner')
    on conflict do nothing;
  end loop;
end $$;
