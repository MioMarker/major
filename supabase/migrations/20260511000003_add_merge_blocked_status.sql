-- 20260511000003_add_merge_blocked_status.sql
-- Implements docs/adr/016-merge-blocked-brief-status.md
--
-- Adds 'merge-blocked' to major.briefs.status. The constraint was created
-- without an explicit name on major.work_items (initial_schema.sql), so PG
-- generated `work_items_status_check`. The table rename in 20260509000004
-- did not rename CHECK constraints, so the old name still lives in the
-- catalog. Drop both possible names defensively and re-add under the
-- post-rename name `briefs_status_check`.

begin;

alter table major.briefs
  drop constraint if exists work_items_status_check;

alter table major.briefs
  drop constraint if exists briefs_status_check;

alter table major.briefs
  add constraint briefs_status_check
  check (status in (
    'ready-for-triage',
    'needs-info',
    'ready-for-agent',
    'agent-running',
    'ready-for-review',
    'ready-for-human',
    'merge-blocked',
    'done',
    'wontfix'
  ));

commit;
