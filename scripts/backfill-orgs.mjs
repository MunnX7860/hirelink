#!/usr/bin/env node
/**
 * Personal-org backfill runner — docs/11 §6.1 + docs/12 (Phase 4 go-live checklist).
 *
 * Migration 0006 already runs this logic inline; this standalone runner exists so
 * the rehearsal can be re-executed (or spot-checked) independently. It is
 * IDEMPOTENT: users who already own an organization (role 'owner' membership) are
 * skipped, so it only ever ADDS a "{Name}'s workspace" shell + owner membership
 * for users who have none. DATA ROWS ARE NEVER TOUCHED — jobs/applicants/tags/
 * integrations stay organization_id IS NULL (personal remains the default view;
 * users.default_organization_id stays unset).
 *
 * Usage:
 *   node scripts/backfill-orgs.mjs --dry-run          # print what WOULD happen
 *   node scripts/backfill-orgs.mjs --yes              # execute
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role —
 * bypasses RLS exactly like the migration's security-definer context).
 */
import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const dryRun = process.argv.includes('--dry-run')
const confirm = process.argv.includes('--yes')

if (!URL || !KEY) {
  console.error('Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}
if (!dryRun && !confirm) {
  console.error('Refusing to write without --yes (or pass --dry-run to preview).')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })

const slug = () =>
  createHash('md5').update(`${randomUUID()}${Date.now()}`).digest('hex').slice(0, 10)

const workspaceName = (user) => {
  const base = (user.full_name ?? '').trim() || (user.email ?? '').split('@')[0] || 'My'
  return `${base}'s workspace`.slice(0, 120)
}

async function main() {
  console.log(`target: ${URL}`)
  console.log(dryRun ? 'mode: DRY RUN (no writes)' : 'mode: EXECUTE')

  // ALL users (service role — mirrors the migration's loop over public.users).
  const users = []
  const PAGE = 500
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('users')
      .select('id, email, full_name')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`users page failed: ${error.message}`)
    users.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }

  const { data: ownerRows, error: ownerError } = await db
    .from('organization_members')
    .select('user_id')
    .eq('role', 'owner')
  if (ownerError) throw new Error(`owner lookup failed: ${ownerError.message}`)
  const owners = new Set((ownerRows ?? []).map((r) => r.user_id))

  const pending = users.filter((u) => !owners.has(u.id))
  console.log(
    `users: ${users.length} · already own an org: ${owners.size} · need a shell: ${pending.length}`,
  )

  let created = 0
  for (const user of pending) {
    const name = workspaceName(user)
    if (dryRun) {
      console.log(`  would create "${name}" for ${user.email ?? user.id}`)
      continue
    }
    // Slug-collision retry loop (astronomically unlikely, mirrors migration 0006).
    let orgId = null
    for (let attempt = 0; attempt < 5 && !orgId; attempt++) {
      const { data, error } = await db
        .from('organizations')
        .insert({ name, slug: slug(), owner_id: user.id })
        .select('id')
        .single()
      if (!error && data) orgId = data.id
      else if (attempt === 4) throw new Error(`org insert failed for ${user.id}: ${error?.message}`)
    }
    const { error: memberError } = await db
      .from('organization_members')
      .insert({ organization_id: orgId, user_id: user.id, role: 'owner' })
    if (memberError && memberError.code !== '23505') {
      throw new Error(`membership insert failed for ${user.id}: ${memberError.message}`)
    }
    created++
    console.log(`  created "${name}" for ${user.email ?? user.id}`)
  }

  console.log(
    dryRun
      ? `dry run complete — ${pending.length} shell(s) would be created.`
      : `done — ${created} shell org(s) created.`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
