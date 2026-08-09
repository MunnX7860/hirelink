import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

export const runtime = 'nodejs'

/** docs/05 §4.8 (Users) — profile notification toggles (docs/02 §9). */
const PatchMeInput = z
  .object({
    notify_telegram: z.boolean().optional(),
    notify_applicant_email: z.boolean().optional(),
  })
  .strict()

export const PATCH = handleRoute(async (_ctx, request: Request) => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 'Sign in required.')

  const input = PatchMeInput.parse(await request.json())
  const updates: Record<string, unknown> = {}
  if (input.notify_telegram !== undefined) updates.notify_telegram = input.notify_telegram
  if (input.notify_applicant_email !== undefined)
    updates.notify_applicant_email = input.notify_applicant_email

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', user.id)
    .select('id, email, full_name, notify_telegram, notify_applicant_email')
    .single()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not save preferences.', { cause: error })
  return data as Record<string, unknown>
})
