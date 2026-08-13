import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow the sandboxed live-preview host to reach the dev server (dev-only).
  allowedDevOrigins: ['*.e2b.app'],
  experimental: {
    // Low-memory environments (small CI/VM): build in-process instead of a
    // separate webpack worker to fit tight RAM budgets.
    webpackBuildWorker: false,
    optimizePackageImports: ['@tanstack/react-query', 'react-hook-form', '@radix-ui/react-icons'],
  },
  // Keep heavy Node SDKs OUT of the webpack bundle — required from node_modules
  // at runtime instead (Vercel traces them automatically). Cuts build memory a lot
  // on small boxes (docs/12 §8).
  serverExternalPackages: [
    'googleapis',
    'google-auth-library',
    'resend',
    'nodemailer',
    '@react-email/render',
    '@react-email/components',
    '@upstash/redis',
    '@upstash/ratelimit',
    // Phase 3 extraction parsers (docs/10 §3) — Node libs, dynamically imported.
    'pdf-parse',
    'mammoth',
  ],
  // CI gates these separately (ci.yml: lint + typecheck jobs). Running them again
  // inside `next build` duplicates the memory footprint of tsc/eslint + webpack
  // and kills small build boxes.
  eslint: {
    ignoreDuringBuilds: true,
    dirs: ['src', 'tests', 'e2e'],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  // Disable the webpack persistent cache: pack serialization is a memory hotspot
  // on tiny build boxes ("Serializing big strings" warnings precede OOM kills).
  webpack: (config, { dev }) => {
    if (!dev) config.cache = false
    return config
  },
  async headers() {
    // Baseline security headers + Phase 2 CSP hardening (docs/03 §7).
    // Notes on the relaxations:
    //  - script-src 'unsafe-inline': Next.js bootstraps RSC payload inline; nonces
    //    for every inline chunk are not supported by the App Router static render.
    //  - style-src 'unsafe-inline': React style attributes + third-party embeds.
    // Both are confined to production-eval'd, first-party code — no eval, no
    // remote script sources.
    const headers: Array<{ key: string; value: string }> = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ]
    // Environment gate — next.config.ts cannot import src/lib/env ('server-only'
    // is rejected by the config compiler). Platform-provided VERCEL_ENV only;
    // the app's secret-carrying env still flows exclusively through src/lib/env.ts.
    const cspHardening = process.env.VERCEL_ENV === 'production' || process.env.CSP_FORCE === '1'
    if (cspHardening) {
      headers.push({
        key: 'Content-Security-Policy',
        value: [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self'",
          "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      })
    }
    return [{ source: '/(.*)', headers }]
  },
}

export default nextConfig
