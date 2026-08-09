-- 0010_workspace_chooser.sql
-- docs/11 §6 / docs/02 §10.1: "First login after activation with >=1 membership
-- -> org chooser surfaces once ('Stay personal' / pick org); choice persists to
-- users.default_organization_id." This was speced but never built — a backfilled
-- or invited member with default_organization_id unset just lands on personal
-- with no prompt. ADDITIVE ONLY, re-runnable, zero data movement.

--------------------------------------------------------------------------------
-- 1. Onboarded flag. `default_organization_id IS NULL` alone can't distinguish
--    "never chosen" from "explicitly chose personal" (switchWorkspace(null) sets
--    it to null too) — this column is that missing signal.
--------------------------------------------------------------------------------
alter table public.users
  add column if not exists workspace_onboarded_at timestamptz;

-- Backfill: a user who already has an explicit default_organization_id has, by
-- construction, already used the switcher — mark them onboarded so they don't
-- see the chooser retroactively. Users still on personal-by-default
-- (default_organization_id IS NULL) are deliberately left NULL here: if they
-- have >=1 org membership, this is exactly the gap this migration closes, and
-- they SHOULD see the one-time chooser on next login.
update public.users
  set workspace_onboarded_at = now()
  where default_organization_id is not null
    and workspace_onboarded_at is null;

--------------------------------------------------------------------------------
-- 2. accept_org_invite (0006): accepting an invite is itself an explicit
--    workspace decision, so stamp workspace_onboarded_at at the same time it
--    fills default_organization_id. Function body otherwise unchanged.
--------------------------------------------------------------------------------
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

  update public.users u
  set default_organization_id = coalesce(u.default_organization_id, v_invite.organization_id),
      workspace_onboarded_at = coalesce(u.workspace_onboarded_at, now())
  where u.id = v_uid;

  select o.name into org_name from public.organizations o where o.id = v_invite.organization_id;
  org_id := v_invite.organization_id;
  role := v_invite.role;
  return next;
end $$;

revoke execute on function public.accept_org_invite(text) from public, anon;
grant execute on function public.accept_org_invite(text) to authenticated;
