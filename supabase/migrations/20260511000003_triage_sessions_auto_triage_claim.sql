-- 20260511000003_triage_sessions_auto_triage_claim.sql
-- Adds Shell claim columns to major.triage_sessions for the auto-triage loop.
-- Implements Brief 49: Shell auto-triage loop for GitHub-seeded sessions.
--
-- auto_triage_shell_id:    set atomically by the Shell claiming the session;
--                          NULL means unclaimed / available.
-- auto_triage_started_at:  timestamp of when the Shell took the claim.
--
-- The claim uses an atomic UPDATE … WHERE auto_triage_shell_id IS NULL so
-- two Shells racing for the same session can't both succeed.

set search_path = major, public;

begin;

alter table major.triage_sessions
  add column if not exists auto_triage_shell_id    text,
  add column if not exists auto_triage_started_at  timestamptz;

-- Partial index speeds up the auto-triage polling query:
-- entry_point = 'integration:github' AND status = 'open'
-- AND auto_triage_shell_id IS NULL
create index if not exists idx_triage_sessions_auto_triage
  on major.triage_sessions (entry_point, status)
  where status = 'open' and auto_triage_shell_id is null;

commit;
