-- 0011_fix_org_rls_recursion.sql
-- Fixes a genuine RLS recursion bug in the ORIGINAL 0004 baseline policies,
-- caught by running migrations against a real, fresh Supabase project for the
-- first time (docs/12's "0006 staging rehearsal" gate — the DB-gated X-suite
-- self-skips without live Supabase, so this was never exercised before).
--
-- Repro: any anon/authenticated query touching `organizations` or
-- `organization_members` fails with `42P17: infinite recursion detected in
-- policy for relation "organization_members"`.
--
-- Root cause: two 0004 policies cross-reference each other's table directly
-- (no security-definer bypass), forming a 2-table RLS evaluation cycle:
--   organizations_member_read (on organizations)   -> queries organization_members
--   organization_members_org_owner (on organization_members) -> queries organizations
-- Evaluating either table's RLS therefore requires evaluating the other's,
-- which requires the first's again, forever.
--
-- Fix: route both cross-table checks through SECURITY DEFINER helper
-- functions (which run as the function owner and bypass RLS on the tables
-- they touch internally), breaking the cycle. Written in plpgsql rather than
-- plain `language sql` — simple single-statement SQL-language functions are
-- eligible for planner inlining, which can silently collapse the
-- security-definer boundary back into the caller's RLS context and reproduce
-- the same recursion; plpgsql functions are never inlined.
--
-- ADDITIVE, re-runnable (create-or-replace / drop-then-create), no data
-- movement.

-- current_org_role (0006) was already `security definer` but declared
-- `language sql` — safe in practice here since it wasn't the active cycle,
-- but converted to plpgsql defensively for the same inlining reason above.
create or replace function public.current_org_role(org uuid)
returns member_role
language plpgsql stable security definer set search_path = public as $$
begin
  return (
    select m.role
    from public.organization_members m
      join public.organizations o on o.id = m.organization_id
    where m.organization_id = org
      and m.user_id = auth.uid()
      and o.deleted_at is null
    limit 1
  );
end;
$$;

-- New helper: mirrors organizations.owner_id directly (distinct from
-- current_org_role's membership-row role — this is the bootstrap check used
-- before an owner's own organization_members row exists yet, e.g. org create).
create or replace function public.is_org_owner(org uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.organizations o
    where o.id = org and o.owner_id = auth.uid()
  );
end;
$$;

drop policy if exists organization_members_org_owner on public.organization_members;
create policy organization_members_org_owner on public.organization_members
  for all using (public.is_org_owner(organization_id));

drop policy if exists organizations_member_read on public.organizations;
create policy organizations_member_read on public.organizations
  for select using (public.current_org_role(id) is not null);
