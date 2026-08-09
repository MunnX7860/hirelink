#!/usr/bin/env node
/**
 * Screening scale seed — docs/13 Phase-5 (S10) + docs/17 §16: populate a
 * 500-candidate probe job (customizable) so the S10 scale gate can run on a
 * live Supabase. Seeds applications + questionnaire answers in a DETERMINISTIC
 * distribution the S10 test re-derives exactly, plus synthetic parse-v2
 * applicant_profiles so AI packing has context without touching Drive.
 *
 * Usage (local/staging Supabase, service role; NEVER run against prod):
 *   SEED_OWNER_ID=<auth users.id> node scripts/seed-screening.mjs [--count=500] [--clean]
 *
 * --clean removes everything this script created (jobs titled "Screening Scale Probe%").
 * After seeding, S10 (e2e/screening.spec.ts) locates the newest probe job,
 * runs the deterministic recompute over it, and — with E2E_WITH_AI=1 — drives a
 * full AI screening session (Batch accelerator) to completion.
 *
 * Verdict pattern by candidate index i (asserted exactly by S10a):
 *   i % 10 === 0 → answers fail the mandatory shift rule  → does_not_meet_mandatory
 *   i % 10 === 1 → mandatory experience answer MISSING    → review_required
 *   otherwise    → passes both                             → qualified
 * Default 500 ⇒ qualified 400 · review_required 50 · DNMC 50.
 */
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const OWNER = process.env.SEED_OWNER_ID
const count = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 500)
const clean = process.argv.includes('--clean')

if (!URL || !KEY || !OWNER) {
  console.error('Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_OWNER_ID.')
  process.exit(1)
}
if (!URL.includes('127.0.0.1') && !URL.includes('localhost') && process.env.SEED_FORCE !== '1') {
  console.error(
    'Refusing to seed a non-local Supabase without SEED_FORCE=1 (staging rehearsal only).',
  )
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })
const BATCH = 250
const PROBE_TITLE_PREFIX = 'Screening Scale Probe'

/** Must stay in sync with e2e/screening.spec.ts (S10 re-derives this exactly). */
export const PROBE_CONFIG = {
  questions: [
    {
      id: 'qshift',
      label: 'Can you work night shifts?',
      type: 'yes_no',
      classification: 'mandatory',
      rule: { op: 'eq', value: true },
    },
    {
      id: 'qexp',
      label: 'Years of relevant experience?',
      type: 'number',
      classification: 'mandatory',
      rule: { op: 'min', value: 2 },
    },
  ],
}

const SKILLS = [
  ['nursing', 'patient care'],
  ['sql', 'power bi', 'reporting'],
  ['retail', 'pos systems'],
  ['phlebotomy', 'lab safety'],
  ['excel', 'data entry'],
  ['logistics', 'warehouse ops'],
]

function profilePayload(i) {
  const skills = SKILLS[i % SKILLS.length]
  const years = 2 + (i % 18)
  return {
    total_experience_years: years,
    location: i % 3 === 0 ? 'Lucknow' : 'Remote',
    current_ctc: null, // CTC only when explicitly stated — the seed never states it
    expected_ctc: null,
    notice_period: i % 4 === 0 ? '30 days' : null,
    skills: [...skills],
    tools: skills.slice(0, 1),
    employers: [
      { name: `Seed Employer ${i % 25}`, title: 'Associate', months: years * 12, industry: null },
    ],
    education: [{ degree: i % 5 === 0 ? 'B.Sc' : 'Diploma', institution: null, year: null }],
    projects: [],
    responsibilities_summary: `Seeded scale candidate — ${skills.join(', ')} for about ${years} years.`,
  }
}

async function main() {
  if (clean) {
    const { data: jobs } = await db
      .from('jobs')
      .select('id')
      .eq('owner_id', OWNER)
      .like('title', `${PROBE_TITLE_PREFIX}%`)
    const ids = (jobs ?? []).map((j) => j.id)
    if (ids.length > 0) {
      await db.from('jobs').delete().in('id', ids) // cascades applications/answers/sessions
    }
    console.log(`cleaned ${ids.length} screening probe jobs`)
    return
  }

  const { data: job, error: jobError } = await db
    .from('jobs')
    .insert({
      owner_id: OWNER,
      title: `${PROBE_TITLE_PREFIX} ${new Date().toISOString()}`,
      status: 'active',
      screening_config: PROBE_CONFIG,
    })
    .select('id')
    .single()
  if (jobError) throw jobError
  console.log(`job ${job.id} — seeding ${count} candidates (answers + profiles)`)

  let expected = { qualified: 0, review_required: 0, does_not_meet_mandatory: 0 }
  for (let offset = 0; offset < count; offset += BATCH) {
    const n = Math.min(BATCH, count - offset)

    const applicantRows = Array.from({ length: n }, (_, k) => ({
      owner_id: OWNER,
      full_name: `Scale Person ${offset + k}`,
      email: `scale.person.${offset + k}@example.test`,
      phone: offset + k === 0 ? '+91 9000000000' : null,
      source: 'instagram',
    }))
    const { data: applicants, error: aErr } = await db
      .from('applicants')
      .insert(applicantRows)
      .select('id')
    if (aErr) throw aErr

    const appRows = applicants.map((a) => ({ job_id: job.id, applicant_id: a.id, status: 'new' }))
    const { data: apps, error: appErr } = await db
      .from('applications')
      .insert(appRows)
      .select('id, applicant_id')
    if (appErr) throw appErr

    const answerRows = []
    const profileRows = []
    apps.forEach((app, k) => {
      const i = offset + k
      const dnmc = i % 10 === 0
      const review = i % 10 === 1
      if (dnmc) expected.does_not_meet_mandatory += 1
      else if (review) expected.review_required += 1
      else expected.qualified += 1

      answerRows.push({
        application_id: app.id,
        applicant_id: app.applicant_id,
        question_id: 'qshift',
        answer: !dnmc, // DNMC bucket answers No to the mandatory shift question
      })
      if (!review) {
        // review bucket leaves the mandatory experience question EMPTY → ambiguous
        answerRows.push({
          application_id: app.id,
          applicant_id: app.applicant_id,
          question_id: 'qexp',
          answer: 2 + (i % 18),
        })
      }
      profileRows.push({
        applicant_id: app.applicant_id,
        payload: profilePayload(i),
        prompt_version: 'seed',
        source_resume_id: null,
      })
    })

    const { error: ansErr } = await db.from('application_answers').insert(answerRows)
    if (ansErr) throw ansErr
    const { error: prErr } = await db.from('applicant_profiles').insert(profileRows)
    if (prErr) throw prErr
    console.log(`  … ${Math.min(offset + BATCH, count)} / ${count}`)
  }

  console.log('done.')
  console.log(`probe job: "${PROBE_TITLE_PREFIX} …" (id ${job.id})`)
  console.log('expected deterministic verdicts after POST /api/jobs/:id/screening-recompute:')
  console.log(
    `  qualified ${expected.qualified} · review_required ${expected.review_required} · does_not_meet_mandatory ${expected.does_not_meet_mandatory}`,
  )
  console.log('next: run the S-suite — E2E_WITH_DB=1 [E2E_WITH_AI=1 E2E_AI_API_KEY=…] npm run e2e')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
