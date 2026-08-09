import { handleRoute } from '@/lib/errors'
import { ConnectAiInput } from '@/features/ai/schemas'
import { verifyAndStoreAiKey } from '@/features/ai/server'
import { assertCapability, requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/**
 * POST /api/integrations/ai — docs/05 §4.7/§4.9 + docs/10 §1: paste key → 1-token
 * verification ping → AES-256-GCM encrypt → store (write-only; key_hint masked).
 * In an org workspace the key becomes the org BYOK pool (docs/11 §3) —
 * requires integrations.manage.
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  if (scope.kind === 'org') assertCapability(scope, 'integrations.manage')

  const input = ConnectAiInput.parse(await request.json())
  return verifyAndStoreAiKey(supabase, scope, input.api_key)
})
