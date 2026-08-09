-- 0008_phase5_screening_async.sql
-- Phase 5 Stage 5.4 (docs/17 §9): async processing support. ADDITIVE ONLY,
-- re-runnable. No data movement.

--------------------------------------------------------------------------------
-- 1. Processing lease on sessions (single-processor guard + quota cooldown)
--------------------------------------------------------------------------------
-- Semantics (17 §9.1–§9.2): any advancer (after()-kickoff, cron worker,
-- advance-on-view) must CAS-claim the session first (locked_at null or lease
-- expired). A quota_limited pause keeps locked_at=now as a ~2-minute cooldown
-- marker; a slice finishing cleanly releases it to null; a crashed run is
-- reclaimed after the 10-minute lease expiry.
alter table public.ai_screening_sessions
  add column if not exists locked_at timestamptz;

--------------------------------------------------------------------------------
-- 2. Worker selection index (partial — active sessions only; cron polls this
--------------------------------------------------------------------------------
create index if not exists screening_sessions_active_idx
  on public.ai_screening_sessions (created_at asc)
  where status in ('queued', 'processing', 'quota_limited');
