import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    // tsconfig keeps `jsx: preserve` (for Next); tests compile TSX with the
    // automatic runtime instead ("React is not defined" otherwise).
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // The `server-only` package throws outside RSC resolution; stub it for tests.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Dummy-but-valid boot env (mirrors .env.example) — lib/env.ts parses at import.
    env: {
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-dummy-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-dummy-service-role-key',
      ENCRYPTION_SECRET: 'a'.repeat(64),
    },
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/features/**/server.ts'],
      thresholds: { lines: 60 },
    },
  },
})
