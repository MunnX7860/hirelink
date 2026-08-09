import { test, expect } from '@playwright/test'

/**
 * Real-provider contract tests (docs/13 Test Pyramid row 5; docs/07 §8, docs/08
 * §6, docs/09 §6). Runs weekly via `.github/workflows/weekly-integrations.yml`,
 * never per-PR — these hit REAL Drive/Telegram/Resend APIs to catch upstream
 * contract drift (payload shape changes, auth changes) that fake-transport unit
 * tests can't see. Alert-only, never blocks merges.
 *
 * Deliberately standalone: these call the provider HTTP APIs directly (mirroring
 * the request shapes `src/lib/notifications/telegram.ts` / `src/lib/ai/gemini.ts`
 * build) rather than importing those modules, since every one of them is tagged
 * `import 'server-only'` and isn't safe to load outside the Next.js RSC/route
 * boundary — Playwright's Node runtime has no equivalent to the `server-only`
 * alias vitest.config.ts sets up for unit tests.
 *
 * Self-skips per-suite when its env vars aren't set (same posture as
 * E2E_WITH_AI/E2E_WITH_DB elsewhere in this repo) — safe to run with none, some,
 * or all three configured.
 */

const HAS_TELEGRAM_FIXTURE = Boolean(
  process.env.TELEGRAM_TEST_BOT_TOKEN && process.env.TELEGRAM_TEST_CHAT_ID,
)
const HAS_DRIVE_FIXTURE = Boolean(
  process.env.DRIVE_TEST_CLIENT_ID &&
  process.env.DRIVE_TEST_CLIENT_SECRET &&
  process.env.DRIVE_TEST_REFRESH_TOKEN &&
  process.env.DRIVE_TEST_FOLDER_ID,
)
const HAS_RESEND_FIXTURE = Boolean(
  process.env.RESEND_API_KEY?.startsWith('re_test_') && process.env.RESEND_TEST_TO,
)

test.describe('Telegram Bot API contract (docs/08 §6)', () => {
  test.skip(!HAS_TELEGRAM_FIXTURE, 'needs TELEGRAM_TEST_BOT_TOKEN + TELEGRAM_TEST_CHAT_ID')

  test('getMe succeeds against the real Bot API', async ({ request }) => {
    const res = await request.get(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TEST_BOT_TOKEN}/getMe`,
    )
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as { ok: boolean; result?: { username?: string } }
    expect(body.ok).toBe(true)
    expect(body.result?.username).toBeTruthy()
  })

  test('sendMessage to the private test chat with MarkdownV2 + an inline button', async ({
    request,
  }) => {
    const res = await request.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_TEST_BOT_TOKEN}/sendMessage`,
      {
        data: {
          chat_id: process.env.TELEGRAM_TEST_CHAT_ID,
          text: '🔧 *weekly\\-integrations* contract check — HireLink CI',
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: 'HireLink', url: 'https://github.com' }]],
          },
        },
      },
    )
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as {
      ok: boolean
      result?: { reply_markup?: { inline_keyboard?: unknown } }
    }
    expect(body.ok).toBe(true)
    expect(body.result?.reply_markup?.inline_keyboard).toBeTruthy()
  })
})

test.describe('Google Drive contract (docs/07 §8)', () => {
  test.skip(!HAS_DRIVE_FIXTURE, 'needs DRIVE_TEST_CLIENT_ID/SECRET/REFRESH_TOKEN/FOLDER_ID')

  test('OAuth refresh + upload-then-delete in the quarantined test folder', async ({ request }) => {
    const tokenRes = await request.post('https://oauth2.googleapis.com/token', {
      form: {
        client_id: process.env.DRIVE_TEST_CLIENT_ID as string,
        client_secret: process.env.DRIVE_TEST_CLIENT_SECRET as string,
        refresh_token: process.env.DRIVE_TEST_REFRESH_TOKEN as string,
        grant_type: 'refresh_token',
      },
    })
    expect(tokenRes.ok()).toBe(true)
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }
    expect(accessToken).toBeTruthy()

    const uploadRes = await request.post(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=media',
      {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'text/plain',
        },
        data: `hirelink weekly-integrations contract check — ${new Date().toISOString()}`,
      },
    )
    expect(uploadRes.ok()).toBe(true)
    const { id: fileId } = (await uploadRes.json()) as { id: string }
    expect(fileId).toBeTruthy()

    // Move it into the quarantined test folder (docs/07 §8) then delete —
    // never leaves a stray file behind even if a later assertion throws.
    try {
      const patchRes = await request.patch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${process.env.DRIVE_TEST_FOLDER_ID}`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      )
      expect(patchRes.ok()).toBe(true)
    } finally {
      const deleteRes = await request.delete(
        `https://www.googleapis.com/drive/v3/files/${fileId}`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      )
      expect(deleteRes.ok()).toBe(true)
    }
  })
})

test.describe('Resend contract (docs/09 §6)', () => {
  test.skip(!HAS_RESEND_FIXTURE, 'needs RESEND_API_KEY=re_test_… + RESEND_TEST_TO')

  test('send accepts the application_received payload shape without real delivery', async ({
    request,
  }) => {
    const res = await request.post('https://api.resend.com/emails', {
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      data: {
        from: 'HireLink <notifications@example.com>',
        to: process.env.RESEND_TEST_TO,
        subject: 'weekly-integrations contract check',
        html: '<p>HireLink CI contract check — test mode, not delivered.</p>',
        text: 'HireLink CI contract check — test mode, not delivered.',
      },
    })
    expect(res.ok()).toBe(true)
    const body = (await res.json()) as { id?: string }
    expect(body.id).toBeTruthy()
  })
})
