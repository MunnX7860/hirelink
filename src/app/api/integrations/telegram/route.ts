import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { encryptSecret, maskSecret } from '@/lib/crypto'
import {
  telegramDetectChatId,
  telegramGetMe,
  sendTelegramMessage,
} from '@/lib/notifications/telegram'
import { env, features } from '@/lib/env'
import { assertCapability, requireWorkspace } from '@/features/orgs/server'
import { getOrgIntegration, getIntegration } from '@/lib/integrations/resolve'
import { z } from 'zod'

export const runtime = 'nodejs'

const Body = z
  .object({
    bot_token: z.string().trim().min(20, 'Paste the full bot token from @BotFather').optional(),
    chat_id: z
      .string()
      .trim()
      .regex(/^-?\d+$/, 'Chat ID is a number (use Detect to find it)')
      .optional(),
    detect: z.boolean().default(false),
    /** Phase 4 (docs/11 §3): connect the shared platform bot — org workspaces only. */
    shared: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.shared || v.bot_token, { message: 'bot_token (or shared: true) required' })

/**
 * POST /api/integrations/telegram — docs/05 §4.6/§4.9 + docs/02 §8.2 + docs/11 §3.
 * Validates token (getMe), optionally auto-detects chat_id via getUpdates,
 * verifies with a real test message, THEN stores the encrypted token.
 * In an org workspace: requires integrations.manage; the row becomes the org-wide channel.
 * `{ shared: true }` stores only a chat_id — the token resolves from
 * TELEGRAM_SHARED_BOT_TOKEN at send time (nothing secret to store).
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, user, scope } = await requireWorkspace()

  const body = Body.parse(await request.json())
  const orgId = scope.kind === 'org' ? scope.orgId : null
  if (orgId) assertCapability(scope, 'integrations.manage')

  if (body.shared) {
    if (!features.sharedTelegramBot || !env.TELEGRAM_SHARED_BOT_TOKEN) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'The shared bot is not available on this deployment.',
        { details: { shared: ['Ask the workspace owner to connect a dedicated bot instead.'] } },
      )
    }
    if (!orgId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'The shared bot is only available in organization workspaces.',
        { details: { shared: ['Switch to an organization first.'] } },
      )
    }
    if (!body.chat_id) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Chat ID is missing.', {
        details: {
          chat_id: ['Add the shared bot to your channel/group, then paste its chat ID.'],
        },
      })
    }
    const test = await sendTelegramMessage({
      botToken: env.TELEGRAM_SHARED_BOT_TOKEN,
      chatId: body.chat_id,
      text: 'HireLink shared bot connected ✅ This channel now gets new-applicant alerts\\.',
    })
    if (!test.ok) {
      throw new AppError(
        ErrorCode.INTEGRATION_ERROR,
        'Could not message that chat — add the shared bot to the channel/group first, then retry.',
      )
    }
    // Replace the org-level row (one live row per (org, type) — docs/11 §3).
    const existing = await getOrgIntegration(supabase, orgId, 'telegram')
    if (existing) {
      await supabase
        .from('integrations')
        .update({
          status: 'active',
          credentials_encrypted: null,
          config: { chat_id: body.chat_id, shared: true },
        })
        .eq('id', existing.id)
    } else {
      const { error } = await supabase.from('integrations').insert({
        owner_id: user.id,
        organization_id: orgId,
        type: 'telegram',
        status: 'active',
        credentials_encrypted: null,
        config: { chat_id: body.chat_id, shared: true },
      })
      if (error)
        throw new AppError(ErrorCode.INTERNAL, 'Could not save the connection.', { cause: error })
    }
    return { ok: true, shared: true, chat_id: body.chat_id, bot_username: null }
  }

  const botToken = body.bot_token as string // refine() guarantees presence when !shared
  const me = await telegramGetMe(botToken)
  if (!me.ok) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'That bot token did not work.', {
      details: { bot_token: ['Invalid token — copy it exactly from @BotFather.'] },
    })
  }

  let chatId = body.chat_id ?? null
  if (!chatId && body.detect) {
    chatId = await telegramDetectChatId(botToken)
    if (!chatId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Could not detect your chat yet.', {
        details: {
          chat_id: [
            `Open @${me.botUsername ?? 'your-bot'} in Telegram and press START, then try Detect again.`,
          ],
        },
      })
    }
  }
  if (!chatId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Chat ID is missing.', {
      details: { chat_id: ['Press "Detect my chat" or paste the chat ID.'] },
    })
  }

  // Verify end-to-end: a real test message before accepting (docs/02 §8.2).
  const test = await sendTelegramMessage({
    botToken,
    chatId,
    text: 'HireLink connected ✅ You will get new-applicant alerts here\\.',
  })
  if (!test.ok) {
    throw new AppError(
      ErrorCode.INTEGRATION_ERROR,
      'Token works, but the test message failed. Start a chat with your bot first, then retry.',
    )
  }

  // Replace the existing connection in THIS scope (docs/11 §3 precedence-safe).
  const existing = orgId
    ? await getOrgIntegration(supabase, orgId, 'telegram')
    : await getIntegration(supabase, user.id, 'telegram')
  if (existing) {
    const { error } = await supabase
      .from('integrations')
      .update({
        status: 'active',
        credentials_encrypted: encryptSecret(botToken),
        config: { chat_id: chatId, bot_username: me.botUsername ?? null, shared: false },
      })
      .eq('id', existing.id)
    if (error)
      throw new AppError(ErrorCode.INTERNAL, 'Could not save the connection.', { cause: error })
  } else {
    const { error } = await supabase.from('integrations').insert({
      owner_id: user.id,
      organization_id: orgId,
      type: 'telegram',
      status: 'active',
      credentials_encrypted: encryptSecret(botToken),
      config: { chat_id: chatId, bot_username: me.botUsername ?? null, shared: false },
    })
    if (error)
      throw new AppError(ErrorCode.INTERNAL, 'Could not save the connection.', { cause: error })
  }

  return {
    ok: true,
    shared: false,
    bot_username: me.botUsername ?? null,
    chat_id: chatId,
    token_hint: maskSecret(botToken),
  }
})
