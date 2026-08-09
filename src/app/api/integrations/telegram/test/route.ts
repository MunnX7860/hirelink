import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { resolveTelegram } from '@/lib/integrations/resolve'
import { sendTelegramMessage } from '@/lib/notifications/telegram'
import { requireWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'

export const runtime = 'nodejs'

/** POST /api/integrations/telegram/test — docs/05 §4.6: 200 {ok} or 502 INTEGRATION_ERROR
 *  (workspace-precedence resolution, docs/11 §3). */
export const POST = handleRoute(async () => {
  const { supabase, scope } = await requireWorkspace()

  const creds = await resolveTelegram(supabase, refForScope(scope))
  if (!creds) throw new AppError(ErrorCode.INTEGRATION_ERROR, 'Telegram is not connected.')

  const result = await sendTelegramMessage({
    botToken: creds.botToken,
    chatId: creds.chatId,
    text: 'Test from HireLink ✅ Alerts are working\\.',
  })
  if (!result.ok) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      result.code === 'telegram_blocked'
        ? 'Your bot is blocked — unblock it in Telegram and try again.'
        : 'Test message failed. Check the bot token and chat ID.',
    )
  }
  return { ok: true }
})
