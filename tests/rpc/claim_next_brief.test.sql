-- tests/rpc/claim_next_brief.test.sql
-- pgTAP regression suite for major.claim_next_brief (v2, Stream B).
--
-- Run via scripts/test-rpc.sh or:
--   pg_prove --dbname <URL> tests/rpc/claim_next_brief.test.sql
--
-- Covered cases (issue #146 / Plan 001 §3 Stream E):
--   1. Empty queue → no row returned
--   2. Normal claim → run created, brief transitions to agent-running
--   3. Concurrent race → only one caller wins (SKIP LOCKED semantics)
--   4. Idempotent retry → same idempotency key returns same run (F-06)
--   5. Skip Brief with active auto_triage_request (F-07)

begin;
create schema if not exists _test;
\ir helpers.sql

select plan(15);

-- ─────────────────────────────────────────────────────────────────
-- 1. Empty queue → no row returned
-- ─────────────────────────────────────────────────────────────────

do $$ begin perform _test.make_shell('shell-empty'); end $$;

select is(
  (select count(*) from major.claim_next_brief('shell-empty', null, 5, 'execute', null)),
  0::bigint,
  '1.1 empty queue returns no rows'
);

-- ─────────────────────────────────────────────────────────────────
-- 2. Normal claim
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_brief_id bigint;
  v_result   record;
begin
  v_brief_id := _test.make_brief('ready-for-agent');
  perform _test.make_shell('shell-normal');
  select * into v_result
  from major.claim_next_brief('shell-normal', v_brief_id, 5, 'execute', 'idem-normal-1');

  -- Run row created
  if not exists (select 1 from major.runs where id = v_result.run_id and outcome = 'running') then
    raise exception 'run not found or not running';
  end if;

  -- Brief transitioned to agent-running
  if not exists (select 1 from major.briefs where id = v_brief_id and status = 'agent-running') then
    raise exception 'brief not in agent-running';
  end if;
end $$;

select ok(true, '2.1 normal claim: run created in running outcome');
select ok(true, '2.2 normal claim: brief transitions to agent-running');

-- run-started event emitted
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    join major.shells s on s.id = r.shell_id
    where s.id = 'shell-normal'
      and e.type = 'run-started'
  ),
  '2.3 normal claim: run-started event inserted'
);

-- status-transitioned event emitted
select ok(
  exists (
    select 1 from major.events e
    join major.runs r on r.id = e.run_id
    join major.shells s on s.id = r.shell_id
    where s.id = 'shell-normal'
      and e.type = 'status-transitioned'
      and e.payload->>'from' = 'ready-for-agent'
      and e.payload->>'to' = 'agent-running'
  ),
  '2.4 normal claim: status-transitioned event inserted'
);

-- claim_idempotency_key persisted on run row
select ok(
  exists (
    select 1 from major.runs r
    join major.shells s on s.id = r.shell_id
    where s.id = 'shell-normal'
      and r.claim_idempotency_key = 'idem-normal-1'
  ),
  '2.5 normal claim: claim_idempotency_key persisted on run'
);

-- ─────────────────────────────────────────────────────────────────
-- 3. Concurrent race — SKIP LOCKED semantics
-- ─────────────────────────────────────────────────────────────────
-- Within one session we can simulate by claiming and then attempting
-- a second claim on the same brief (already agent-running → 0 rows).

do $$
declare
  v_brief_id bigint;
begin
  v_brief_id := _test.make_brief('ready-for-agent');
  perform _test.make_shell('shell-race-a');
  perform _test.make_shell('shell-race-b');
  -- shell-race-a claims it
  perform major.claim_next_brief('shell-race-a', v_brief_id, 5, 'execute', 'idem-race-a');
  -- shell-race-b tries to claim the same brief (already agent-running → 0 rows)
  perform major.claim_next_brief('shell-race-b', v_brief_id, 5, 'execute', 'idem-race-b');
end $$;

select is(
  (select count(*) from major.runs where shell_id = 'shell-race-b' and outcome = 'running'),
  0::bigint,
  '3.1 race: second claimer gets no run (brief already agent-running)'
);

select is(
  (select count(*) from major.runs where shell_id = 'shell-race-a' and outcome = 'running'),
  1::bigint,
  '3.2 race: first claimer holds exactly one running run'
);

-- ─────────────────────────────────────────────────────────────────
-- 4. Idempotent retry — same idempotency key returns same run (F-06)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_brief_id bigint;
  v_run1     bigint;
  v_run2     bigint;
begin
  v_brief_id := _test.make_brief('ready-for-agent');
  perform _test.make_shell('shell-idem');
  select run_id into v_run1
    from major.claim_next_brief('shell-idem', v_brief_id, 5, 'execute', 'idem-retry-key-1');
  select run_id into v_run2
    from major.claim_next_brief('shell-idem', v_brief_id, 5, 'execute', 'idem-retry-key-1');
  if v_run1 is distinct from v_run2 then
    raise exception 'idempotent retry returned different run_id: % vs %', v_run1, v_run2;
  end if;
end $$;

select ok(true, '4.1 idempotent retry: same key returns same run_id');

-- Only one run row should exist for this shell+key combination.
select is(
  (select count(*) from major.runs where shell_id = 'shell-idem'
     and claim_idempotency_key = 'idem-retry-key-1'),
  1::bigint,
  '4.2 idempotent retry: exactly one run row created (no orphan duplicate)'
);

-- ─────────────────────────────────────────────────────────────────
-- 5. Skip Brief with active auto_triage_request (F-07)
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_brief_id bigint;
begin
  v_brief_id := _test.make_brief('ready-for-agent');
  perform _test.make_shell('shell-skip-atr');

  -- Insert an active auto_triage_request for this brief.
  insert into major.auto_triage_requests (brief_id, status)
  values (v_brief_id, 'running');

  -- Claim attempt should skip this brief (return 0 rows).
  perform major.claim_next_brief('shell-skip-atr', v_brief_id, 5, 'execute', null);
end $$;

select is(
  (select count(*) from major.runs where shell_id = 'shell-skip-atr'),
  0::bigint,
  '5.1 skip-auto-triage: brief with active ATR not claimed'
);

-- Brief must still be ready-for-agent (not transitioned by the failed claim).
select ok(
  exists (
    select 1 from major.briefs b
    join major.auto_triage_requests atr on atr.brief_id = b.id
    where atr.status = 'running'
      and b.status = 'ready-for-agent'
  ),
  '5.2 skip-auto-triage: brief remains ready-for-agent when ATR is active'
);

-- ─────────────────────────────────────────────────────────────────

select * from finish();
rollback;
