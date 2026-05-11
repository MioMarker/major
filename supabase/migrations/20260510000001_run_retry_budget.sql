-- 20260510000001_run_retry_budget.sql
-- Implements docs/adr/014-run-retry-budget.md
--
-- Adds the Run retry budget columns:
--   * major.briefs.max_attempts    — per-Brief auto-retry cap (default 3).
--   * major.runs.attempt_number    — which attempt this Run is for the Brief
--                                    (default 1, reset on new Content Revision).
--
-- The cap and counter are metadata (AGENTS.md hard rule #2). Existing rows
-- backfill via the column defaults; no data migration is required. The
-- counter-reset semantics (new Content Revision → attempt_number = 1) and
-- the auto-retry decision live in the major-claim-brief RPC and shell/main.ts
-- respectively, and ship in follow-on PRs per ADR 014's "Follow-on work".
--
-- Append-only, additive: no existing code path observes these columns until
-- the RPC + Shell changes land.

set search_path = major, public;

begin;

alter table major.briefs
  add column if not exists max_attempts integer not null default 3;

alter table major.runs
  add column if not exists attempt_number integer not null default 1;

commit;
