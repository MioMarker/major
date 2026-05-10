-- 20260510000000_briefs_source_issue.sql
-- Implements docs/adr/007-auto-close-brief-and-issue-on-pr-terminal.md
--
-- Adds two nullable columns to major.briefs that record the GitHub issue
-- (if any) that originated the Brief. Populated by major-create-triage-session
-- when the trigger came from a GitHub issue webhook ('integration:github'
-- initiator); left null for human-initiated triage and synthetic seeds.
--
-- The PR-merge webhook (handlePullRequest) reads these columns at terminal
-- transition time to know whether to close a source issue alongside the
-- Brief's done transition.
--
-- Append-only, additive: no behavior change in existing code paths until
-- the webhook handler PR lands and starts populating + reading these.

set search_path = major, public;

begin;

alter table major.briefs
  add column if not exists source_issue_repo   text,
  add column if not exists source_issue_number integer;

create index if not exists idx_briefs_source_issue
  on major.briefs (source_issue_repo, source_issue_number)
  where source_issue_repo is not null;

commit;
