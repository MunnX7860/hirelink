import { test, expect } from '@playwright/test'

/**
 * Phase 3 AI routes — docs/13 §2.5 endpoint matrix (always-on: auth + envelope).
 * The four AI features + key connect must reject anonymous traffic; 400/502
 * behaviour without a key is covered DB-gated in ai-degradation.spec.ts.
 */

const ZERO = '00000000-0000-0000-0000-000000000000'
const AI_ROUTES: Array<{ name: string; path: string; body: unknown }> = [
  { name: 'parse-resume', path: '/api/ai/parse-resume', body: { resume_id: ZERO } },
  { name: 'summarize', path: '/api/ai/summarize-applicant', body: { applicant_id: ZERO } },
  { name: 'jd', path: '/api/ai/generate/job-description', body: { title: 'Barista' } },
  { name: 'social', path: '/api/ai/generate/social-post', body: { job_id: ZERO } },
  { name: 'connect', path: '/api/integrations/ai', body: { api_key: 'AIza-not-real' } },
]

for (const route of AI_ROUTES) {
  test(`POST ${route.path} → 401 envelope when signed out`, async ({ request }) => {
    const res = await request.post(route.path, { data: route.body })
    expect(res.status()).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(json.error.request_id).toBeTruthy()
  })
}
