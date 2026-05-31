-- 20260531000000_purge_closed_triage_sessions_cron.sql
-- Implements docs/adr/024-closed-triage-session-retention-purge.md.
--
-- Adds a pg_cron janitor that PERMANENTLY deletes `closed` Triage Sessions once
-- they have been `closed` for >= 2 days. `closed` is terminal; this is a
-- retention sweep, not a lifecycle transition — the parallel of major.reaper_sweep
-- and major.purge_done_briefs. Triage Session acceptance is implicit (no
-- human-only boundary like Brief `done`); the purge only touches sessions that
-- already reached `closed`.
--
-- Age anchor (ADR 024): triage_sessions.updated_at. Triage Sessions are not
-- routinely touched after closure — major-finalize-triage-session is the last
-- writer — so updated_at approximates closed-at to within seconds. If a future
-- code path mutates closed sessions (e.g. retroactive transcript edit), this
-- anchor drifts and we add a closed_at column at that point.
--
-- Scope: `closed` ONLY. `open` is never touched; a stale-open auto-close policy
-- is its own decision (its own retention, its own user-visible behavior).
--
-- Cascade handling (ADR 024 § "What about child Briefs?" + § Decision):
--   triage_change_sets.triage_session_id is declared `references triage_sessions(id)`
--   WITHOUT `on delete cascade` (see 20260509000000_initial_schema.sql:207); deleting
--   a session row with dependent change sets would raise a foreign-key violation.
--   So inside one transaction:
--     1. Nullify briefs.source_session_id pointing at the to-be-purged sessions
--        (child Briefs survive as independent rows — matches the single-delete
--        endpoint's behavior).
--     2. Delete the dependent triage_change_sets rows. Their Operations cascade
--        from change sets (triage_change_operations.change_set_id has
--        `on delete cascade` at line 228).
--     3. Delete the triage_sessions rows.
--
-- Mechanism (ADR 024 / ADR 023 § "How to wire the cron"): pure-SQL pg_cron.
-- pg_cron runs inside Postgres, so the job is `select major.purge_closed_triage_sessions(2)`
-- directly — no edge function, no net.http_post, no service-role key in cron SQL.
-- The whole job (function + schedule) is captured here; no manual dashboard step.
--
-- Observability: each sweep writes one `triage-sessions-purged` Telemetry Record
-- (deleted_count + retention window) and is visible in cron.job_run_details.
--
-- Depends on:
--   * 20260509000000_initial_schema.sql              (triage_sessions, triage_change_sets,
--                                                     triage_change_operations FK cascade,
--                                                     briefs/work_items.source_session_id,
--                                                     telemetry_records)
--   * 20260509000004_gits_renames.sql                (work_item_id -> brief_id rename)
--   * 20260509000006_telemetry_idempotency_rpc.sql   (telemetry_records.idempotency_key)
--   * 20260525000006_purge_done_briefs_cron.sql      (pg_cron already enabled; pattern reference)

set search_path = major, public;

begin;

-- pg_cron is already enabled (the Reaper and the Brief purge both depend on it);
-- this is a defensive no-op so the migration is self-contained per
-- .claude/rules/db/migrations.md.
create extension if not exists pg_cron;

-- ═══════════════════════════════════════════════════════════════
-- purge_closed_triage_sessions — retention sweep for terminal `closed` sessions
-- ═══════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER so the pg_cron job (and any service_role caller) executes the
-- delete with the owner's rights. `search_path = ''` pins resolution; every object
-- is schema-qualified (built-ins resolve from the implicit pg_catalog).
--
-- retention_days is the only knob; default 2 matches ADR 024. To change the window,
-- supersede the schedule in a new migration — do not edit this one (append-only).

create or replace function major.purge_closed_triage_sessions(retention_days integer default 2)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ids     bigint[];
  v_deleted integer := 0;
begin
  if retention_days is null or retention_days < 0 then
    raise exception 'purge_closed_triage_sessions: retention_days must be a non-negative integer, got %', retention_days;
  end if;

  -- Collect targets first; the subsequent statements all key off the same id set.
  select coalesce(array_agg(s.id), array[]::bigint[])
    into v_ids
  from major.triage_sessions s
  where s.status = 'closed'
    and s.updated_at < now() - make_interval(days => retention_days);

  v_deleted := coalesce(array_length(v_ids, 1), 0);

  if v_deleted > 0 then
    -- 1. Preserve child Briefs by nullifying their session pointer (matches
    --    major-delete-triage-session). FK has no `on delete set null` clause, so
    --    we do it explicitly.
    update major.briefs
       set source_session_id = null
     where source_session_id = any(v_ids);

    -- 2. Delete dependent Change Sets. Operations cascade from change_set_id.
    delete from major.triage_change_sets
     where triage_session_id = any(v_ids);

    -- 3. Delete the sessions themselves.
    delete from major.triage_sessions
     where id = any(v_ids);
  end if;

  -- One operational record per sweep (non-lifecycle). brief_id/run_id are null —
  -- this is a global sweep with no per-Brief scope.
  insert into major.telemetry_records (brief_id, run_id, observation_type, payload, idempotency_key)
  values (
    null,
    null,
    'triage-sessions-purged',
    jsonb_build_object(
      'deleted_count', v_deleted,
      'retention_days', retention_days,
      'swept_at', now()
    ),
    'triage-sessions-purged:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS')
  );

  return v_deleted;
end;
$fn$;

grant execute on function major.purge_closed_triage_sessions(integer) to service_role;

-- ═══════════════════════════════════════════════════════════════
-- Schedule: daily at 09:23 UTC — six minutes after the done-Brief purge (09:17)
-- so they don't share a transaction window. Idempotent — drop any prior
-- registration first so re-applying this migration never duplicates the job.
-- Job name is namespaced (`major-*`) because pg_cron is global to the shared dev
-- project.
-- ═══════════════════════════════════════════════════════════════

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'major-purge-closed-triage-sessions') then
    perform cron.unschedule('major-purge-closed-triage-sessions');
  end if;
end
$do$;

select cron.schedule(
  'major-purge-closed-triage-sessions',
  '23 9 * * *',
  'select major.purge_closed_triage_sessions(2);'
);

commit;
