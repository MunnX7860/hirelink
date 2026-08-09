import { test, expect } from '@playwright/test'

/**
 * E-health — docs/13 §3. Public, offline-friendly smoke check.
 */
test('GET /api/health returns the documented shape', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(typeof body.db).toBe('boolean')
  expect(typeof body.version).toBe('string')
  expect(res.headers()['x-request-id']).toBeTruthy()
})
