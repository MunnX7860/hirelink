-- 0001_extensions_enums.sql
-- docs/04 §2 + §7. Append-only history — never edit after it has been applied anywhere shared.

-- Extensions
create extension if not exists pgcrypto; -- gen_random_uuid()
create extension if not exists citext;   -- case-insensitive applicant emails
create extension if not exists pg_trgm;  -- Phase 2 free-text search (indexed in 0003)

-- Enums (extend later ONLY via `alter type ... add value` — non-reversible, flagged in PRs)
create type job_status          as enum ('draft', 'active', 'closed');
create type application_status  as enum ('new','reviewing','shortlisted','interview','offered','hired','rejected','archived');
create type upload_status       as enum ('uploaded','failed');
create type integration_type    as enum ('google_drive','telegram','email','ai');
create type integration_status  as enum ('active','error','disconnected');
create type member_role         as enum ('owner','admin','member');            -- Phase 4
create type timeline_event_type as enum (
  'application_created','status_changed','note_added','tag_added','tag_removed',
  'resume_uploaded','resume_failed','email_sent','email_failed',
  'telegram_sent','telegram_failed','ai_summary_generated','applicant_created'
);
