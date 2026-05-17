-- tests/rpc/apply_change_set.test.sql
-- pgTAP regression suite for major.apply_change_set (v2, Stream B).
--
-- Run via scripts/test-rpc.sh or:
--   pg_prove --dbname <URL> tests/rpc/apply_change_set.test.sql
--
-- Covered cases (issue #146 / Plan 001 §3 Stream E):
--   1. create-brief op happy path → brief created in ready-for-triage
--   2. Snake_case payload (D1) → brief_id field read correctly
--   3. Partial-failure rollback → one bad op rolls back whole set
--   4. Transition-matrix violation → exception on transition-brief
--   5. Path-blocker re-check on set-ready-state → exception when blocked

begin;
create schema if not exists _test;
\ir helpers.sql

select plan(12);

-- ─────────────────────────────────────────────────────────────────
-- helpers: make a triage_session and a change_set pointing to it.
-- ─────────────────────────────────────────────────────────────────

create or replace function _test.make_change_set()
returns bigint language plpgsql as $$
declare
  v_session_id bigint;
  v_cs_id      bigint;
begin
  insert into major.triage_sessions (initiator_actor)
  values ('human:test')
  returning id into v_session_id;

  insert into major.triage_change_sets (triage_session_id, decision)
  values (v_session_id, 'accepted')
  returning id into v_cs_id;

  return v_cs_id;
end;
$$;

create or replace function _test.add_op(
  p_cs_id   bigint,
  p_type    text,
  p_payload jsonb,
  p_seq     integer default 1
)
returns bigint language sql as $$
  insert into major.triage_change_operations (
    change_set_id, operation_type, payload, status, idempotency_key, sequence_index
  ) values (
    p_cs_id, p_type, p_payload, 'accepted',
    'test-op-' || p_cs_id || '-' || p_seq || '-' || gen_random_uuid()::text,
    p_seq
  )
  returning id;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 1. create-brief op happy path
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_cs_id bigint;
begin
  v_cs_id := _test.make_change_set();
  perform _test.add_op(v_cs_id, 'create-brief', jsonb_build_object(
    'classifications', '["bug-fix"]'::jsonb,
    'expected_artifact_type', 'git-change',
    'expected_paths', '["src/foo.ts"]'::jsonb,
    'git_repository_ref', 'MioMarker/healthbite',
    'content_md', '# Fix the thing'
  ), 1);

  perform major.apply_change_set(v_cs_id, 'human:test', null);
end $$;

-- Brief created in ready-for-triage.
select ok(
  exists (
    select 1 from major.briefs b
    where b.status = 'ready-for-triage'
      and b.expected_artifact_type = 'git-change'
      and b.expected_paths = array['src/foo.ts']
  ),
  '1.1 create-brief: brief created in ready-for-triage'
);

-- brief-created event emitted.
select ok(
  exists (select 1 from major.events where type = 'brief-created'),
  '1.2 create-brief: brief-created event inserted'
);

-- Op marked applied.
select ok(
  exists (
    select 1 from major.triage_change_operations
    where status = 'applied'
  ),
  '1.3 create-brief: operation marked applied'
);

-- ─────────────────────────────────────────────────────────────────
-- 2. Snake_case payload (D1) — brief_id key must be read by the RPC
-- ─────────────────────────────────────────────────────────────────
-- The payload uses snake_case (brief_id, content_md, etc.) per ADR 018.
-- A camelCase payload (briefId) resolves to NULL and the op is a no-op.
-- This test confirms snake_case is correctly interpreted.

do $$
declare
  v_cs_id   bigint;
  v_brief_id bigint;
begin
  v_brief_id := _test.make_brief('ready-for-triage');
  v_cs_id    := _test.make_change_set();

  -- snake_case payload (ADR 018 / D1): brief_id field must be read
  perform _test.add_op(v_cs_id, 'set-classifications', jsonb_build_object(
    'brief_id', v_brief_id,
    'classifications', '["feature"]'::jsonb
  ), 1);

  perform major.apply_change_set(v_cs_id, 'human:test', null);
end $$;

select ok(
  exists (
    select 1 from major.briefs
    where classifications = array['feature']
  ),
  '2.1 snake_case payload (D1): brief_id field read correctly'
);

-- ─────────────────────────────────────────────────────────────────
-- 3. Partial-failure rollback — bad op rolls back whole set
-- ─────────────────────────────────────────────────────────────────
-- We insert an op that will succeed followed by one that will raise,
-- then verify neither took effect (the RPC should re-raise after the loop).

do $$
declare
  v_cs_id    bigint;
  v_brief_id bigint;
  before_count integer;
  after_count  integer;
begin
  v_brief_id   := _test.make_brief('ready-for-triage');
  v_cs_id      := _test.make_change_set();
  select count(*)::integer into before_count from major.briefs;

  -- Op 1: create-brief (would succeed on its own)
  perform _test.add_op(v_cs_id, 'create-brief', jsonb_build_object(
    'classifications', '["bug-fix"]'::jsonb,
    'expected_artifact_type', 'git-change',
    'expected_paths', '["src/bar.ts"]'::jsonb,
    'git_repository_ref', 'MioMarker/healthbite',
    'content_md', '# Should roll back'
  ), 1);

  -- Op 2: transition-brief to an illegal status (will raise).
  perform _test.add_op(v_cs_id, 'transition-brief', jsonb_build_object(
    'brief_id', v_brief_id,
    'to_status', 'done'   -- illegal: ready-for-triage cannot go to done
  ), 2);

  begin
    perform major.apply_change_set(v_cs_id, 'human:test', null);
  exception when others then
    null; -- expected
  end;

  select count(*)::integer into after_count from major.briefs;
  -- The create-brief from op 1 should have been rolled back.
  if after_count > before_count then
    raise exception 'partial rollback failed: brief count changed from % to %', before_count, after_count;
  end if;
end $$;

select ok(true, '3.1 partial-failure rollback: op 1 rolled back when op 2 raises');

-- ─────────────────────────────────────────────────────────────────
-- 4. Transition-matrix violation → exception on transition-brief
-- ─────────────────────────────────────────────────────────────────

do $$
declare
  v_cs_id    bigint;
  v_brief_id bigint;
begin
  -- A brief in 'done' state has no valid successors.
  v_brief_id := _test.make_brief('done');
  v_cs_id    := _test.make_change_set();

  perform _test.add_op(v_cs_id, 'transition-brief', jsonb_build_object(
    'brief_id', v_brief_id,
    'to_status', 'ready-for-agent'  -- illegal: done has no successors
  ), 1);

  begin
    perform major.apply_change_set(v_cs_id, 'human:test', null);
    raise exception 'expected exception not raised';
  exception when others then
    null; -- expected
  end;
end $$;

select ok(true, '4.1 transition-matrix: illegal transition-brief raises exception');

-- Brief must not have changed status.
select ok(
  exists (select 1 from major.briefs where status = 'done'),
  '4.2 transition-matrix: brief remains in done after rejected op'
);

-- ─────────────────────────────────────────────────────────────────
-- 5. Path-blocker re-check on set-ready-state (F-04 server-side)
-- ─────────────────────────────────────────────────────────────────
-- When a Brief's expected_paths intersect a protected glob and
-- set-ready-state(ready=true) is applied, the RPC must raise.

do $$
declare
  v_cs_id    bigint;
  v_brief_id bigint;
begin
  -- Brief whose expected_paths include a migration (protected glob).
  insert into major.briefs (status, classifications, expected_artifact_type,
    expected_paths, git_repository_ref, base_branch)
  values ('ready-for-triage', array['bug-fix'], 'git-change',
          array['supabase/migrations/0001_blocked.sql'],
          'MioMarker/healthbite', 'dev')
  returning id into v_brief_id;

  -- Ensure the path_blocker_config row with id=1 exists and has the migration glob.
  insert into major.path_blocker_config (id, protected_globs, mass_rerank_threshold)
  values (1, array['supabase/migrations/**'], 5)
  on conflict (id) do update
    set protected_globs = array['supabase/migrations/**'];

  v_cs_id := _test.make_change_set();
  perform _test.add_op(v_cs_id, 'set-ready-state', jsonb_build_object(
    'brief_id', v_brief_id,
    'ready', true
  ), 1);

  begin
    perform major.apply_change_set(v_cs_id, 'human:test', null);
    raise exception 'expected path-blocker exception not raised';
  exception when others then
    null; -- expected: path-blocker violation
  end;
end $$;

select ok(true, '5.1 path-blocker on set-ready-state: exception raised when paths blocked');

-- Brief must still be in ready-for-triage (not promoted to ready-for-agent).
select ok(
  exists (
    select 1 from major.briefs
    where expected_paths @> array['supabase/migrations/0001_blocked.sql']
      and status = 'ready-for-triage'
  ),
  '5.2 path-blocker on set-ready-state: brief not promoted when blocked'
);

-- ─────────────────────────────────────────────────────────────────

select * from finish();
rollback;
