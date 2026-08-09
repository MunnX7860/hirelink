#!/usr/bin/env node
/**
 * Perf seed — docs/13 §3 perf budgets (Phase 2): populate ~10k applications so
 * list/search/board queries can be budget-checked against real data.
 *
 * Usage (local Supabase, service role; NEVER run against prod):
 *   SEED_OWNER_ID=<auth users.id> node scripts/seed-perf.mjs [--count=10000] [--clean]
 *
 * --clean removes everything this script created (jobs titled "Perf Probe%")
 * for the same owner.
 */
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OWNER = process.env.SEED_OWNER_ID
const count = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 10_000)
const clean = process.argv.includes('--clean')

if (!URL || !KEY || !OWNER) {
  console.error('Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_OWNER_ID.')
  process.exit(1)
}
if (!URL.includes('127.0.0.1') && !URL.includes('localhost') && process.env.SEED_FORCE !== '1') {
  console.error('Refusing to seed a non-local Supabase without SEED_FORCE=1.')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })
const BATCH = 500

async function main() {
  if (clean) {
    const { data: jobs } = await db
      .from('jobs')
      .select('id')
      .eq('owner_id', OWNER)
      .like('title', 'Perf Probe%')
    const ids = (jobs ?? []).map((j) => j.id)
    if (ids.length > 0) {
      await db.from('jobs').delete().in('id', ids) // cascades applications/resumes/events
    }
    console.log(`cleaned ${ids.length} perf jobs`)
    return
  }

  const { data: job, error: jobError } = await db
    .from('jobs')
    .insert({ owner_id: OWNER, title: `Perf Probe ${new Date().toISOString()}`, status: 'active' })
    .select('id')
    .single()
  if (jobError) throw jobError
  console.log(`job ${job.id} — seeding ${count} applications`)

  const statuses = ['new', 'reviewing', 'shortlisted', 'interview', 'offered', 'hired']
  let applicants = 0
  let applications = 0
  for (let offset = 0; offset < count; offset += BATCH) {
    const n = Math.min(BATCH, count - offset)
    const applicantRows = Array.from({ length: n }, (_, i) => {
      const k = offset + i
      return {
        owner_id: OWNER,
        full_name: `Perf Person ${k}`,
        email: `perf.person.${k}@example.test`,
        phone: k % 3 === 0 ? `+91 90000${String(k).padStart(5, '0')}` : null,
        source: k % 2 === 0 ? 'instagram' : 'direct',
      }
    })
    const { data: inserted, error: aErr } = await db
      .from('applicants')
      .insert(applicantRows)
      .select('id')
    if (aErr) throw aErr
    applicants += inserted.length

    const appRows = inserted.map((a, i) => ({
      job_id: job.id,
      applicant_id: a.id,
      status: statuses[(offset + i) % statuses.length],
      source_meta: {},
    }))
    const { error: appErr } = await db.from('applications').insert(appRows)
    if (appErr) throw appErr
    applications += appRows.length
    console.log(`  …${applicants}/${count}`)
  }
  console.log(`done: ${applicants} applicants, ${applications} applications`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
