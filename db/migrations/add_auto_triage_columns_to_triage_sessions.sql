-- add_auto_triage_columns_to_triage_sessions.sql
-- Adds Shell auto-triage claim columns to major.triage_sessions.
-- Supports the Shell triageSessionLoop() atomic optimistic-claim pattern:
--   UPDATE major.triage_sessions
--   SET auto_triage_shell_id = $1, auto_triage_started_at = now()
--   WHERE id = $2 AND auto_triage_shell_id IS NULL
-- 0 rows affected = race lost; 1 row affected = claimed.
--
-- NOTE: This file is tracked under db/migrations/ per expectedPaths in Brief 26.
-- It must be applied to the Supabase project via:
--   cp db/migrations/add_auto_triage_columns_to_triage_sessions.sql \
--     supabase/migrations/20260511000003_auto_triage_columns.sql
--   npx -y supabase db push
-- The supabase/migrations/ directory uses YYYYMMDDHHMMSS-prefixed names per
-- CLAUDE.md §Directory ownership; this file serves as the authoritative SQL source.

begin;

alter table major.triage_sessions
  add column if not exists auto_triage_shell_id   text,
  add column if not exists auto_triage_started_at timestamptz;

commit;
