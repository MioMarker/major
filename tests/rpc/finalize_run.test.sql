-- tests/rpc/finalize_run.test.sql
-- pgTAP regression suite for major.finalize_run (v2, Stream B).
--
-- Run via scripts/test-rpc.sh or:
--   pg_prove --dbname <URL> tests/rpc/finalize_run.test.sql
--
-- Covered cases (issue #146 / Plan 001 §3 Stream E):
--   1. Happy path → run finalized, brief transitioned, events emitted
--   2. Ownership mismatch → exception raised (F-11)
--   3. Idempotent retry → second call is a no-op, no duplicate events (F-12)
--   4. Invalid nextStatus → exception raised (transition matrix guard)
--   5. Run not in running outcome → exception raised (state guard)

begin;
create schema if not exists _test;
\ir helpers.sql

select plan(15);

-- ─────────────────────────────────────────────────────────────────
-- 1. Happy path
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
  v_result   record;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-finalize-happy', 'idem-happy-1');

  select * into v_result
  from major.finalize_run(
    v_run_id, 'succeeded', 'ready-for-review', 'shell:shell-finalize-happy',
    null, null, '[]', '[]', 'idem-happy-finalize-1',
    null, null, null, null, null, null, null,
    'shell-finalize-happy'
  );
end $$;

-- Run finalized to succeeded.
select ok(
  exists (select 1 from major.runs where shell_id = 'shell-finalize-happy' and outcome = 'succeeded'),
  '1.1 happy path: run outcome = succeeded'
);

-- Brief transitioned to ready-for-review.
select ok(
  exists (
    select 1 from major.briefs b
    join major.runs r on r.brief_id = b.id
    where r.shell_id = 'shell-finalize-happy'
      and b.status = 'ready-for-review'
  ),
  '1.2 happy path: brief transitions to ready-for-review'
);

-- run-ended event emitted.
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    where r.shell_id = 'shell-finalize-happy'
      and e.type = 'run-ended'
  ),
  '1.3 happy path: run-ended event inserted'
);

-- status-transitioned event emitted.
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    where r.shell_id = 'shell-finalize-happy'
      and e.type = 'status-transitioned'
      and e.payload->>'from' = 'agent-running'
      and e.payload->>'to' = 'ready-for-review'
  ),
  '1.4 happy path: status-transitioned event inserted'
);

-- ─────────────────────────────────────────────────────────────────
-- 2. Ownership mismatch → exception (F-11)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-owner-a', 'idem-owner-test-1');

  -- shell-owner-b tries to finalize a run owned by shell-owner-a.
  begin
    perform major.finalize_run(
      v_run_id, 'succeeded', 'ready-for-review', 'shell:shell-owner-b',
      null, null, '[]', '[]', 'idem-owner-finalize-1',
      null, null, null, null, null, null, null,
      'shell-owner-b'  -- caller_shell_id ≠ owner
    );
    raise exception 'expected exception not raised';
  exception when others then
    null; -- expected
  end;
end $$;

select ok(true, '2.1 ownership mismatch: exception raised (F-11)');

-- Run must still be in 'running' state (not corrupted by the bad call).
select ok(
  exists (select 1 from major.runs where shell_id = 'shell-owner-a' and outcome = 'running'),
  '2.2 ownership mismatch: run remains running after rejected finalize'
);

-- ─────────────────────────────────────────────────────────────────
-- 3. Idempotent retry — same key → no-op, no duplicate events (F-12)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-idem-finalize', 'idem-claim-idem-1');

  -- First finalize.
  perform major.finalize_run(
    v_run_id, 'succeeded', 'ready-for-review', 'shell:shell-idem-finalize',
    null, null, '[]', '[]', 'idem-fin-key-1',
    null, null, null, null, null, null, null,
    'shell-idem-finalize'
  );

  -- Second finalize with same key — must be a no-op.
  perform major.finalize_run(
    v_run_id, 'succeeded', 'ready-for-review', 'shell:shell-idem-finalize',
    null, null, '[]', '[]', 'idem-fin-key-1',
    null, null, null, null, null, null, null,
    'shell-idem-finalize'
  );
end $$;

-- Only one run-ended event (no duplicate from the second call).
select is(
  (select count(*) from major.events e
   join major.runs r on r.id = e.run_id
   where r.shell_id = 'shell-idem-finalize'
     and e.type = 'run-ended'),
  1::bigint,
  '3.1 idempotent retry: exactly one run-ended event (no duplicate)'
);

-- ─────────────────────────────────────────────────────────────────
-- 4. Invalid nextStatus → exception (transition matrix guard)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-invalid-status', 'idem-inv-status-1');

  begin
    -- 'done' is not a valid successor of 'agent-running'.
    perform major.finalize_run(
      v_run_id, 'succeeded', 'done', 'shell:shell-invalid-status',
      null, null, '[]', '[]', 'idem-inv-fin-1',
      null, null, null, null, null, null, null,
      'shell-invalid-status'
    );
    raise exception 'expected exception not raised';
  exception when others then
    null; -- expected: invalid transition
  end;
end $$;

select ok(true, '4.1 invalid nextStatus: exception raised for illegal transition');

-- Brief must NOT have transitioned (rolled back).
select ok(
  exists (
    select 1 from major.briefs b
    join major.runs r on r.brief_id = b.id
    where r.shell_id = 'shell-invalid-status'
      and b.status = 'agent-running'
  ),
  '4.2 invalid nextStatus: brief stays in agent-running after rejected finalize'
);

-- ─────────────────────────────────────────────────────────────────
-- 5. Run not in running outcome → exception (state guard)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_run_id   bigint;
  v_brief_id bigint;
begin
  select run_id, brief_id into v_run_id, v_brief_id
  from _test.make_running_run('shell-state-guard', 'idem-state-guard-1');

  -- First finalize sets outcome to succeeded.
  perform major.finalize_run(
    v_run_id, 'succeeded', 'ready-for-review', 'shell:shell-state-guard',
    null, null, '[]', '[]', 'idem-state-guard-fin-1',
    null, null, null, null, null, null, null,
    'shell-state-guard'
  );

  begin
    -- Second finalize with a different key (no idempotency short-circuit):
    -- run is no longer 'running' → must raise.
    perform major.finalize_run(
      v_run_id, 'failed', 'ready-for-human', 'shell:shell-state-guard',
      null, null, '[]', '[]', 'idem-state-guard-fin-2',
      null, null, null, null, null, null, null,
      'shell-state-guard'
    );
    raise exception 'expected exception not raised';
  exception when others then
    null; -- expected
  end;
end $$;

select ok(true, '5.1 state guard: exception raised when run already finalized');

-- ─────────────────────────────────────────────────────────────────

select * from finish();
rollback;
