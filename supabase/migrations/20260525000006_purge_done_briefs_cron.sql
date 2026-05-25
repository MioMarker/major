-- 20260525000006_purge_done_briefs_cron.sql
-- Implements docs/adr/023-done-brief-retention-purge.md.
--
-- Adds a pg_cron janitor that PERMANENTLY deletes `done` Briefs once they have
-- been `done` for >= 3 days. `done` is terminal; this is a retention sweep, not a
-- lifecycle transition — the same category as major.reaper_sweep (an existing
-- pg_cron background actor). Acceptance stays human-only (Hard Rule / boundary 10):
-- the purge only ever removes Briefs a human already drove to `done`.
--
-- Age anchor (ADR 023): the latest `status-transitioned` Event whose payload.to =
-- 'done' — written on BOTH paths into `done` (major-confirm-qa and the ADR 007
-- PR-merge webhook). This is the precise, immutable became-done time and is
-- Metadata, not Content. Legacy `done` Briefs predating that Event convention have
-- no such Event; for them we fall back to briefs.updated_at.
--
-- Scope: `done` ONLY. `wontfix` is also terminal but is left for manual deletion
-- (eased by the companion Briefs-View multi-select). Broadening to `wontfix` is a
-- one-line predicate change in a future migration.
--
-- Deletion cascades via existing FKs (the same cascade major-delete-brief relies
-- on): Events, Runs, Verification Results, Artifacts, Content Revisions, and
-- Relationship edges of the purged Brief are removed with it.
--
-- Mechanism (ADR 023): pure-SQL pg_cron. pg_cron runs inside Postgres, so the job
-- is `select major.purge_done_briefs(3)` directly — no edge function, no
-- net.http_post, no service-role key in cron SQL. The whole job (function +
-- schedule) is captured here; no manual dashboard step (unlike the Reaper, whose
-- schedule is dashboard-registered — see docs/runbook.md §1.4).
--
-- Observability: each sweep writes one `briefs-purged` Telemetry Record
-- (deleted_count + retention window) and is visible in cron.job_run_details.
--
-- Depends on:
--   * 20260509000000_initial_schema.sql   (briefs/events/telemetry_records, FK cascade)
--   * 20260509000004_gits_renames.sql      (work_item_id -> brief_id rename)
--   * 20260509000006_telemetry_idempotency_rpc.sql (telemetry_records.idempotency_key)
--   * pg_cron enabled on the dev project (already true — the Reaper uses it)

set search_path = major, public;

begin;

-- pg_cron is already enabled on the dev project (the Reaper depends on it); this is
-- a defensive no-op so the migration is self-contained per .claude/rules/db/migrations.md.
create extension if not exists pg_cron;

-- ═══════════════════════════════════════════════════════════════
-- purge_done_briefs — retention sweep for terminal `done` Briefs
-- ═══════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER so the pg_cron job (and any service_role caller) executes the
-- delete with the owner's rights. `search_path = ''` pins resolution; every object
-- is schema-qualified (built-ins resolve from the implicit pg_catalog).
--
-- retention_days is the only knob; default 3 matches ADR 023. To change the window,
-- supersede the schedule in a new migration — do not edit this one (append-only).

create or replace function major.purge_done_briefs(retention_days integer default 3)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer := 0;
begin
  if retention_days is null or retention_days < 0 then
    raise exception 'purge_done_briefs: retention_days must be a non-negative integer, got %', retention_days;
  end if;

  -- Delete every `done` Brief whose became-done time is older than the window.
  -- became-done = max(status-transitioned->done Event.created_at), falling back to
  -- updated_at for legacy Briefs with no such Event. Cascade FKs clean the rest.
  with purged as (
    delete from major.briefs b
    where b.status = 'done'
      and coalesce(
            (
              select max(e.created_at)
              from major.events e
              where e.brief_id = b.id
                and e.type = 'status-transitioned'
                and e.payload ->> 'to' = 'done'
            ),
            b.updated_at
          ) < now() - make_interval(days => retention_days)
    returning b.id
  )
  select count(*)::integer into v_deleted from purged;

  -- One operational record per sweep (non-lifecycle). brief_id/run_id are null —
  -- this is a global sweep, not scoped to a Brief (and the purged Briefs are gone).
  insert into major.telemetry_records (brief_id, run_id, observation_type, payload, idempotency_key)
  values (
    null,
    null,
    'briefs-purged',
    jsonb_build_object(
      'deleted_count', v_deleted,
      'retention_days', retention_days,
      'swept_at', now()
    ),
    'briefs-purged:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS')
  );

  return v_deleted;
end;
$fn$;

grant execute on function major.purge_done_briefs(integer) to service_role;

-- ═══════════════════════════════════════════════════════════════
-- Schedule: daily at 09:17 UTC. Idempotent — drop any prior registration first so
-- re-applying this migration never duplicates the job. Job name is namespaced
-- (`major-*`) because pg_cron is global to the shared dev project.
-- ═══════════════════════════════════════════════════════════════

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'major-purge-done-briefs') then
    perform cron.unschedule('major-purge-done-briefs');
  end if;
end
$do$;

select cron.schedule(
  'major-purge-done-briefs',
  '17 9 * * *',
  'select major.purge_done_briefs(3);'
);

commit;
