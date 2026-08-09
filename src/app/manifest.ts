import type { MetadataRoute } from 'next'

/** Public PWA manifest — docs/15 Phase 2 scope. Installable shell, standalone display. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'HireLink',
    short_name: 'HireLink',
    description: 'The simplest mobile-first hiring & talent CRM for social-media hiring.',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#6366f1',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}
