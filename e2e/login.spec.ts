import { test, expect } from '@playwright/test'

/**
 * E1-prereq — docs/13 §3: login screen renders the single primary action, and
 * the app shell is protected (unauthenticated /dashboard → /login).
 * Runs offline (dummy Supabase env); real Google OAuth is exercised in staging.
 */
test('login page renders brand + Google button and nothing else primary', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
  await expect(page.getByText('HireLink')).toBeVisible()
})

test('/dashboard redirects unauthenticated users to /login', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})
