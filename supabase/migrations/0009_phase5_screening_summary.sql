-- 0009_phase5_screening_summary.sql
-- Phase 5 Stage 5.5 (docs/17 §13): immutable Google Drive summary artifact per
-- completed screening session. ADDITIVE ONLY, re-runnable. No data movement.

--------------------------------------------------------------------------------
-- 1. Artifact cache on the session row (17 §13: folder created lazily under
--    the job folder, id cached here; sibling sessions of the same job reuse
--    the first cached folder id; the uploaded file id lands on summary_file_id)
--------------------------------------------------------------------------------
alter table public.ai_screening_sessions
  add column if not exists summary_folder_id text,
  add column if not exists summary_file_id text;
