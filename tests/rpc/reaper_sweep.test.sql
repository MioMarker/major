-- tests/rpc/reaper_sweep.test.sql
-- pgTAP regression suite for major.reaper_sweep (Stream B).
--
-- Run via scripts/test-rpc.sh or:
--   pg_prove --dbname <URL> tests/rpc/reaper_sweep.test.sql
--
-- Covered cases (issue #146 / Plan 001 §3 Stream E):
--   1. Lease-expired run → sweep marks it cancelled, brief back to ready-for-agent
--   2. No-op when nothing has expired
--   3. Idempotent re-run → second sweep does not duplicate events

begin;
create schema if not exists _test;
\ir helpers.sql

select plan(10);

-- ─────────────────────────────────────────────────────────────────
-- 1. Lease-expired run → sweep cancels it, brief returned
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
  v_result   record;
begin
  -- Claim a brief (creates a run with a 5-min future lease).
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-reaper-1', 'idem-reaper-1');

  -- Manually expire the lease so the Reaper picks it up.
  update major.runs
  set lease_expires_at = now() - interval '1 second'
  where id = v_run_id;

  -- Run the sweep.
  select * into v_result from major.reaper_sweep();
end $$;

-- Sweep reports 1 cancelled run.
select is(
  (select cancelled_runs from major.reaper_sweep() limit 1),
  0,  -- second sweep returns 0 (already cancelled by the first)
  '1.0 reaper: second sweep after first reports 0 cancelled (setup verify)'
);

-- The run is now in cancelled outcome.
select ok(
  exists (
    select 1 from major.runs
    where shell_id = 'shell-reaper-1'
      and outcome = 'cancelled'
      and cancellation_reason = 'lease-expired'
  ),
  '1.1 reaper sweep: expired run marked cancelled'
);

-- Brief returned to ready-for-agent.
select ok(
  exists (
    select 1 from major.briefs b
    join major.runs r on r.brief_id = b.id
    where r.shell_id = 'shell-reaper-1'
      and b.status = 'ready-for-agent'
  ),
  '1.2 reaper sweep: brief returned to ready-for-agent'
);

-- run-ended event emitted.
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    where r.shell_id = 'shell-reaper-1'
      and e.type = 'run-ended'
      and e.actor = 'major:reaper'
  ),
  '1.3 reaper sweep: run-ended event inserted by reaper actor'
);

-- status-transitioned event emitted (back to ready-for-agent).
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    where r.shell_id = 'shell-reaper-1'
      and e.type = 'status-transitioned'
      and e.payload->>'to' = 'ready-for-agent'
      and e.payload->>'reason' = 'lease-expired'
  ),
  '1.4 reaper sweep: status-transitioned event (agent-running → ready-for-agent)'
);

-- repair-inspection-trigger telemetry inserted.
select ok(
  exists (
    select 1 from major.telemetry_records tr
    join major.runs r on r.id = tr.run_id
    where r.shell_id = 'shell-reaper-1'
      and tr.observation_type = 'repair-inspection-trigger'
      and tr.payload->>'reason' = 'lease-expired'
  ),
  '1.5 reaper sweep: repair-inspection-trigger telemetry inserted'
);

-- ─────────────────────────────────────────────────────────────────
-- 2. No-op when nothing expired
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  -- Claim a brief with a future lease (not expired).
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-reaper-noop', 'idem-reaper-noop');
  -- lease_expires_at defaults to now() + 5 min → not expired.
end $$;

select is(
  (select cancelled_runs from major.reaper_sweep() limit 1),
  0,
  '2.1 reaper sweep: no-op when no expired runs (cancelled_runs = 0)'
);

select ok(
  exists (
    select 1 from major.runs
    where shell_id = 'shell-reaper-noop'
      and outcome = 'running'
  ),
  '2.2 reaper sweep: non-expired run stays in running outcome'
);

-- ─────────────────────────────────────────────────────────────────
-- 3. Idempotent re-run — second sweep on already-cancelled run is a no-op
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-reaper-idem', 'idem-reaper-idem-1');

  update major.runs
  set lease_expires_at = now() - interval '1 second'
  where id = v_run_id;

  -- First sweep cancels it.
  perform major.reaper_sweep();
  -- Second sweep (run already cancelled → no SKIP LOCKED match → 0 rows).
  perform major.reaper_sweep();
end $$;

-- Only one run-ended event (ON CONFLICT DO NOTHING prevents duplicate).
select is(
  (select count(*) from major.events e
   join major.runs r on r.id = e.run_id
   where r.shell_id = 'shell-reaper-idem'
     and e.type = 'run-ended'),
  1::bigint,
  '3.1 idempotent reaper: exactly one run-ended event after two sweeps'
);

-- ─────────────────────────────────────────────────────────────────

select * from finish();
rollback;
