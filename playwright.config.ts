import { defineConfig, devices } from '@playwright/test'

/**
 * E2E critical journeys (docs/13 §3). Mobile viewport is the default — mobile-first (docs/06 §1).
 * Runs against the dev server with dummy env (`.env.e2e.local`) so no real Supabase/Drive is needed.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'mobile-chrome', use: { ...devices['Pixel 7'] } }],
  webServer: {
    // Prod server (not `next dev`): lighter + deterministic for E2E — on-demand
    // dev compiles are memory-hungry and break on small CI/VM boxes.
    command: 'npm run build && npx next start -p 3000',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
})
