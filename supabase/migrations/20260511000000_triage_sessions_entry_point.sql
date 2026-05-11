-- 20260511000000_triage_sessions_entry_point.sql
-- Adds entry_point and trigger_payload to major.triage_sessions.
-- Required by major-import-external-issues and major-quick-start.
-- These columns are also referenced by ADR 010 (issue #65 branch);
-- adding them here unblocks the import flow without waiting for that merge.

set search_path = major, public;

begin;

alter table major.triage_sessions
  add column if not exists entry_point    text,
  add column if not exists trigger_payload jsonb;

commit;
