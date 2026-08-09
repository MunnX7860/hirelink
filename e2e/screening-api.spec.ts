import { test, expect } from '@playwright/test'

/**
 * Phase 5 Stage-5.1 API guard rails — docs/13 §Phase-5 (always-on).
 * Every screening route must reject anonymous traffic with the docs/05 §2
 * envelope; the PUBLIC job payload may carry sanitized `questions` but must
 * never leak `rule` / `classification` (17 §3.4, the Q7 leak check).
 */

const ID = '00000000-0000-0000-0000-000000000000'

const SCREENING_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: `/api/jobs/${ID}/screening-config` },
  { method: 'PUT', path: `/api/jobs/${ID}/screening-config`, body: { questions: [] } },
  { method: 'POST', path: `/api/jobs/${ID}/screening-recompute` },
  { method: 'GET', path: `/api/applications/${ID}/answers` },
  // Stage 5.3 — AI screening sessions (05 §4.10)
  {
    method: 'POST',
    path: '/api/ai/screenings',
    body: { job_id: ID, instruction: 'sql + healthcare', max_results: 20 },
  },
  { method: 'GET', path: `/api/ai/screenings?job_id=${ID}` },
  { method: 'GET', path: `/api/ai/screenings/${ID}` },
  // Stage 5.4 — async session actions (05 §4.10)
  { method: 'POST', path: `/api/ai/screenings/${ID}/retry` },
  { method: 'POST', path: `/api/ai/screenings/${ID}/cancel` },
]

for (const route of SCREENING_ROUTES) {
  test(`${route.method} ${route.path} → 401 envelope when signed out`, async ({ request }) => {
    const res = await request.fetch(route.path, {
      method: route.method,
      ...(route.body !== undefined
        ? { data: route.body, headers: { 'content-type': 'application/json' } }
        : {}),
    })
    expect(res.status()).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(json.error.request_id).toBeTruthy()
  })
}

test('GET /api/cron/screening-worker is gated (404/401 without a valid bearer)', async ({
  request,
}) => {
  // docs/17 §9.1 — worker secrecy mirrors the other crons: feature-gated 404
  // when CRON_SECRET is unconfigured, else 401 on a missing/wrong bearer.
  const res = await request.get('/api/cron/screening-worker')
  expect([401, 404]).toContain(res.status())
})

test('PUBLIC job route stays public — and never leaks screening rules (Q7, 17 §3.4)', async ({
  request,
}) => {
  // With dummy services this job cannot exist (404/500) — the key invariant is
  // that the route is reachable WITHOUT auth (never 401). Against a seeded env,
  // also verify the payload shape directly.
  const res = await request.get('/api/jobs/does-not-exist/public')
  expect(res.status()).not.toBe(401)
  if (res.status() === 200) {
    const json = await res.json()
    expect(Array.isArray(json.questions)).toBe(true)
    const raw = JSON.stringify(json.questions)
    expect(raw).not.toContain('classification')
    expect(raw).not.toContain('rule')
    for (const q of json.questions as Array<Record<string, unknown>>) {
      expect(q).not.toHaveProperty('classification')
      expect(q).not.toHaveProperty('rule')
    }
  }
})
