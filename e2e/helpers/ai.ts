import { createCipheriv, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * E2E live-AI fixture — docs/13 Phase-5: S4–S8 and the S10 batch path need a
 * REAL Gemini key installed on the dev owner (17 §16: "fake transport? no —
 * live key"). Gate: E2E_WITH_AI=1 + E2E_AI_API_KEY + an ENCRYPTION_SECRET that
 * MATCHES the app under test (the server decrypts with its own env; set the
 * same value in the playwright shell, or E2E_ENCRYPTION_SECRET if it differs).
 * Without the gate the AI tests self-skip; S1–S3/S9 and S10a still run.
 */
export const HAS_AI_FIXTURE = Boolean(
  process.env.E2E_WITH_AI &&
  process.env.E2E_AI_API_KEY &&
  (process.env.E2E_ENCRYPTION_SECRET ?? process.env.ENCRYPTION_SECRET),
)

/** Mirror of src/lib/crypto.ts (aes-256-gcm; `v1.<b64url iv>.<b64url tag>.<b64url ct>`). */
function encryptTestSecret(plaintext: string): string {
  const secret = (process.env.E2E_ENCRYPTION_SECRET ?? process.env.ENCRYPTION_SECRET) as string
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

/**
 * Idempotently (re)install the personal `ai` integration row for the owner
 * (service-role write; the one-active-per-type partial index is honored by
 * deleting first). Session CREATE only needs an ACTIVE row — the model is
 * called later during processing — so S9 can pass a deliberate dummy key.
 */
export async function ensureAiIntegration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any>,
  ownerId: string,
  apiKey: string,
): Promise<void> {
  await admin
    .from('integrations')
    .delete()
    .eq('owner_id', ownerId)
    .is('organization_id', null)
    .eq('type', 'ai')
  const { error } = await admin.from('integrations').insert({
    owner_id: ownerId,
    type: 'ai',
    status: 'active',
    credentials_encrypted: encryptTestSecret(apiKey),
    config: { model: 'gemini-2.0-flash' },
  })
  if (error) throw error
}

/** Remove the fixture integration row (suite teardown politeness). */
export async function removeAiIntegration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any>,
  ownerId: string,
): Promise<void> {
  await admin
    .from('integrations')
    .delete()
    .eq('owner_id', ownerId)
    .is('organization_id', null)
    .eq('type', 'ai')
}
