import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Run on everything except static assets. Public routes (/apply, /api/apply,
     * /api/health, /login, /auth/*) handle their own semantics; the session
     * refresh itself is harmless and required for cookie freshness (docs/03 §2).
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
