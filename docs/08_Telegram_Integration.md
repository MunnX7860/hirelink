# 08 — Telegram Integration

> Last updated 2026-08-07. Normative for owner notifications. Design principles: Master PRD D4 — Telegram failure never blocks anything.

## 1. Model (Phase 1)

Telegram bots cannot initiate DMs to users, and BotFather tokens are per-bot. Phase 1 keeps this dead simple and power-user friendly:

- The **owner creates their own bot** via `@BotFather` (guided, copy-paste steps in Settings → Telegram), then starts a chat with the bot and pastes:
  - **Bot token** (encrypted → `integrations.credentials_encrypted`, `type='telegram'`)
  - **Chat ID** (plain → `integrations.config.chat_id` — derived automatically via `getUpdates` after they press "Detect my chat", with manual fallback).
- Validation on save: `getMe` (token valid) + send _"HireLink connected ✅"_ test message (`POST /api/integrations/telegram/test`).

Phase 4 (11) introduces an optional platform-hosted shared bot with group/topic routing; the per-owner bot remains supported.

## 2. Trigger: New Application

**On every application** (`03 §5` step notifications), if owner has active telegram integration AND `users.notify_telegram = true`:

```
🆕 *New applicant — {job_title}*
👤 {full_name}
✉️ {email}   📞 {phone | "—"}
📄 Resume: {uploaded → "attached ✔" | failed → "upload failed ⚠"}
🕐 {relative time, e.g. "just now"}

[View in dashboard]   ← inline keyboard button, URL {APP_URL}/dashboard/applications/{application_id}
```

- Parse mode: `MarkdownV2` with escaping via helper (all user content escaped; template fixed).
- Delivery also fires on `resume_failed` retry success ("Resume recovered for {name}").
- Nothing else pings by default. Future per-integration toggles live in `integrations.config.alerts` (`status_changes`, `daily_digest`) — Phase 2+.

## 3. Sending Details

- Endpoint: `https://api.telegram.org/bot{token}/sendMessage`, `disable_web_page_preview=true`, `reply_markup.inline_keyboard` for the dashboard button.
- Timeouts/retries: 8s timeout; 1 retry after 5s; then give up → `telegram_failed` timeline event (payload: telegram `error_code`, description). Success → `telegram_sent` event. These events power the G3 latency metric (`created_at` deltas).
- Rate: Telegram allows ~30 msg/s global, 1 msg/s per chat — irrelevant at our volume; no batching needed. Long messages: truncate name/title (80 chars), never the link.
- Errors mapped: `401` invalid token → integration `status='error'` + settings banner; `403 bot was blocked` → same status, banner says "Unblock your bot"; `429` → honour `retry_after` once, then fail-soft.

## 4. Message Reliability Policy (normative)

Telegram is **best-effort alerts**, not a system of record: the Inbox (02 §5) is always the full list. Missed alerts are self-healing (next event proves connectivity). No queues in Phase 1; Phase 4 moves delivery behind QStash/Inngest if digests/bulk arrive.

## 5. Security

- Token is a secret: write-only API surface (05 §4.6), AES-256-GCM at rest (D3), never in logs (log `status`, `error_code` only).
- Chat ID is not a secret but is scoped to owner rows; settings UI masks all but last 4 of token (display-only, from a server-computed hint — token never re-sent to client).
- No incoming webhook in Phase 1 (bot is send-only). Phase 4 shared-bot commands ("/status") would add a webhook with secret-path verification.

## 6. Testing

- Unit: MarkdownV2 escaper (table tests for `_[]()~>#+-=|{}.!`), template renderer, error mapper.
- Integration (CI weekly, env-gated `TELEGRAM_TEST_*`): real bot → private test chat; assert message + button URL shape.
- E2E (mocked HTTP): apply → notification service invoked once → failure path writes `telegram_failed` event.
