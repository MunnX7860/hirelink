import { test, expect } from '@playwright/test'

/**
 * Phase 2 API guard rails — docs/13 §2 (always-on, no services needed).
 * Every new owner route must reject anonymous traffic with the docs/05 §2
 * envelope; cron/webhook are feature-gated (404/401 without secrets).
 */

const OWNER_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/applicants' },
  { method: 'GET', path: '/api/applicants/export.csv' },
  {
    method: 'PATCH',
    path: '/api/applicants/00000000-0000-0000-0000-000000000000',
    body: { phone: null },
  },
  {
    method: 'PUT',
    path: '/api/applicants/00000000-0000-0000-0000-000000000000/tags',
    body: { tag_ids: [] },
  },
  { method: 'GET', path: '/api/tags' },
  { method: 'POST', path: '/api/tags', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/tags/00000000-0000-0000-0000-000000000000' },
  {
    method: 'POST',
    path: '/api/notes',
    body: { applicant_id: '00000000-0000-0000-0000-000000000000', body: 'hi' },
  },
  { method: 'DELETE', path: '/api/notes/00000000-0000-0000-0000-000000000000' },
  { method: 'GET', path: '/api/timeline' },
  {
    method: 'PATCH',
    path: '/api/applications',
    body: { ids: ['00000000-0000-0000-0000-000000000000'], action: 'archive', value: '' },
  },
  { method: 'DELETE', path: '/api/applications/00000000-0000-0000-0000-000000000000' },
]

for (const route of OWNER_ROUTES) {
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

test('PWA manifest is public (docs/15 Phase 2)', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest')
  expect(res.status()).toBe(200)
  const json = await res.json()
  expect(json.name).toBe('HireLink')
  expect(json.display).toBe('standalone')
})

// Cron: CI dummy env may or may not set CRON_SECRET — both gated reasons are correct.
test('GET /api/cron/reconcile is gated (401/404 without valid bearer)', async ({ request }) => {
  const res = await request.get('/api/cron/reconcile')
  expect([401, 404]).toContain(res.status())
})

// Webhook: without RESEND_WEBHOOK_SECRET the route must not exist publicly.
test('POST /api/webhooks/resend is gated (401/404 unsigned)', async ({ request }) => {
  const res = await request.post('/api/webhooks/resend', {
    data: { type: 'email.bounced', data: {} },
  })
  expect([401, 404]).toContain(res.status())
})
