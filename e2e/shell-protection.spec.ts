import { test, expect } from '@playwright/test'

/**
 * Shell protection — every authenticated area must redirect to /login when
 * there's no session (middleware, docs/03 §7). Offline-runnable.
 */
const PROTECTED_PATHS = [
  '/dashboard',
  '/dashboard/jobs',
  '/dashboard/jobs/new',
  '/dashboard/people',
  '/dashboard/settings',
  '/dashboard/applications/11111111-2222-3333-4444-555555555555',
  '/dashboard/jobs/11111111-2222-3333-4444-555555555555/screening',
]

for (const path of PROTECTED_PATHS) {
  test(`${path} → /login when unauthenticated`, async ({ page }) => {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login/)
  })
}
