-- 20260516000000_claim_brief_repair_purpose.sql
-- Implements docs/adr/014-run-retry-budget.md §"Schema changes" + §"Auto-retry decision"
--
-- Rewrites the claim_next_brief RPC body to:
--   1. Query the latest completed (non-running) Run for the claimed Brief.
--   2. Compute attempt_number and purpose from prior-Run state per ADR 014:
--      • No prior Run OR current_revision_id > prior started_against_revision_id
--        → attempt_number=1, purpose='execute'   (fresh start / new PRD)
--      • latest_run.outcome='failed' AND latest_run.attempt_number < brief.max_attempts
--        → attempt_number=prior+1, purpose='repair'  (auto-retry below budget)
--      • Else (manual re-arm, above budget, cancelled, succeeded)
--        → attempt_number=prior+1, purpose='execute'
--   3. Set inspected_run_id = prior_run.id when purpose='repair'.
--   4. Insert the new Run row with computed attempt_number, purpose, inspected_run_id.
--
-- The p_purpose parameter is kept for forward-compatibility (future human-override
-- re-arm calls may pass 'repair' explicitly). For automated Shell polls the
-- parameter is not sent, so the default 'execute' applies — but the internal logic
-- always overrides based on prior-Run state. p_purpose is intentionally ignored.
--
-- Depends on:
--   • 20260510000001_run_retry_budget.sql    (briefs.max_attempts, runs.attempt_number)
--   • 20260512000001_rpc_v2_stream_b.sql     (current claim_next_brief body)
--   • initial schema runs.inspected_run_id   (nullable FK, set when purpose=repair)

set search_path = major, public;

begin;

create or replace function major.claim_next_brief(
  p_shell_id           text,
  p_specific_brief_id  bigint  default null,
  p_lease_minutes      integer default 5,
  p_purpose            text    default 'execute',
  p_idempotency_key    text    default null
)
returns table (
  brief_id    bigint,
  run_id      bigint,
  revision_id bigint
) language plpgsql security definer as $$
#variable_conflict use_column
declare
  v_brief_id          bigint;
  v_revision          bigint;
  v_run_id            bigint;
  v_lease             timestamptz := now() + (p_lease_minutes || ' minutes')::interval;
  v_idem              text        := coalesce(p_idempotency_key, gen_random_uuid()::text);
  -- Prior-Run fields for ADR 014 attempt/purpose computation.
  v_prior_run_id      bigint;
  v_prior_outcome     text;
  v_prior_attempt     integer;
  v_prior_revision    bigint;
  -- Computed values inserted into the new Run row.
  v_attempt_number    integer;
  v_computed_purpose  text;
begin
  -- Idempotent-retry: if this Shell already claimed a Brief under this key,
  -- return the existing Run instead of creating a duplicate (F-06).
  -- The `outcome = 'running'` filter prevents the retry from resurrecting
  -- a Run the Reaper has already cancelled.
  select r.brief_id, r.id, r.started_against_revision_id
  into v_brief_id, v_run_id, v_revision
  from major.runs r
  where r.shell_id = p_shell_id
    and r.claim_idempotency_key = v_idem
    and r.outcome = 'running'
  limit 1;

  if found then
    brief_id    := v_brief_id;
    run_id      := v_run_id;
    revision_id := v_revision;
    return next;
    return;
  end if;

  -- Select target brief with row lock; SKIP LOCKED loses to a concurrent
  -- claimer cleanly (returns no row; caller polls again).
  if p_specific_brief_id is not null then
    select id into v_brief_id
    from major.briefs
    where id = p_specific_brief_id
      and status = 'ready-for-agent'
      and not exists (
        select 1 from major.brief_relationships r
        join major.briefs w on w.id = r.parent_id
        where r.child_id = briefs.id
          and r.type = 'blocks'
          and w.status not in ('done', 'wontfix')
      )
      and not exists (
        select 1 from major.auto_triage_requests atr
        where atr.brief_id = briefs.id
          and atr.status in ('requested', 'running')
      )
    for update skip locked;
  else
    select id into v_brief_id
    from major.briefs
    where status = 'ready-for-agent'
      and not exists (
        select 1 from major.brief_relationships r
        join major.briefs w on w.id = r.parent_id
        where r.child_id = briefs.id
          and r.type = 'blocks'
          and w.status not in ('done', 'wontfix')
      )
      and not exists (
        select 1 from major.auto_triage_requests atr
        where atr.brief_id = briefs.id
          and atr.status in ('requested', 'running')
      )
    order by queue_rank asc nulls last, created_at asc
    for update skip locked
    limit 1;
  end if;

  if v_brief_id is null then
    return; -- empty result set; caller returns 409 to shell
  end if;

  -- Capture the current Content Revision so the Run is bound to a
  -- specific PRD version.
  select current_revision_id into v_revision
  from major.briefs
  where id = v_brief_id;

  -- ── ADR 014: compute attempt_number + purpose from prior-Run state ──────────
  --
  -- Find the latest completed (non-running) Run for this Brief.
  -- ORDER BY id DESC picks the most recent by insertion order, which is safe
  -- because Run ids are bigserial (monotonically increasing).
  select r.id, r.outcome, r.attempt_number, r.started_against_revision_id
  into v_prior_run_id, v_prior_outcome, v_prior_attempt, v_prior_revision
  from major.runs r
  where r.brief_id = v_brief_id
    and r.outcome <> 'running'
  order by r.id desc
  limit 1;

  if not found then
    -- No prior completed Run → fresh start.
    v_attempt_number   := 1;
    v_computed_purpose := 'execute';
  elsif v_revision is not null
    and (v_prior_revision is null or v_revision > v_prior_revision) then
    -- Brief has a newer Content Revision than the prior Run saw → the task
    -- changed; reset counter as if this were a first attempt.
    v_attempt_number   := 1;
    v_computed_purpose := 'execute';
  elsif v_prior_outcome = 'failed'
    and v_prior_attempt < (
      select b.max_attempts from major.briefs b where b.id = v_brief_id
    ) then
    -- Failed Run below the retry budget → Repair attempt.
    v_attempt_number   := v_prior_attempt + 1;
    v_computed_purpose := 'repair';
  else
    -- Cancelled Run, succeeded Run, or above budget → fresh execute attempt.
    v_attempt_number   := v_prior_attempt + 1;
    v_computed_purpose := 'execute';
  end if;
  -- ────────────────────────────────────────────────────────────────────────────

  update major.briefs
  set status = 'agent-running'
  where id = v_brief_id;

  insert into major.runs (
    brief_id, purpose, outcome, shell_id,
    started_against_revision_id, claimed_at, lease_expires_at, heartbeat_at,
    claim_idempotency_key,
    attempt_number,
    inspected_run_id
  ) values (
    v_brief_id, v_computed_purpose, 'running', p_shell_id,
    v_revision, now(), v_lease, now(),
    v_idem,
    v_attempt_number,
    -- Link the new Run to the prior failed Run when this is a Repair attempt,
    -- so the Shell can fetch its diagnostics without an extra query.
    case when v_computed_purpose = 'repair' then v_prior_run_id else null end
  )
  returning id into v_run_id;

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, v_run_id, 'run-started', 'shell:' || p_shell_id,
    jsonb_build_object(
      'purpose', v_computed_purpose,
      'attempt_number', v_attempt_number,
      'lease_expires_at', v_lease
    ),
    'run-started:' || v_run_id::text || ':' || v_idem
  );

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, v_run_id, 'status-transitioned', 'shell:' || p_shell_id,
    jsonb_build_object('from', 'ready-for-agent', 'to', 'agent-running'),
    'status-transitioned:' || v_run_id::text || ':' || v_idem
  );

  brief_id    := v_brief_id;
  run_id      := v_run_id;
  revision_id := v_revision;
  return next;
end;
$$;

-- Grant is identical to the previous migration; re-state to keep it in sync.
grant execute on function major.claim_next_brief(text, bigint, integer, text, text) to service_role;

commit;
