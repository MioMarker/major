-- 20260525000004_redeploy_claim_next_brief_attempt_number.sql
-- Implements docs/adr/014-run-retry-budget.md §"Schema changes" + §"Auto-retry
-- decision". Re-asserts the claim_next_brief body authored in
-- 20260516000000_claim_brief_repair_purpose.sql — VERBATIM, no logic change.
--
-- INCIDENT (#169, retry storm): the finalize_run (20260525000002) and reaper_sweep
-- (20260525000003) retry-budget caps were live but NEVER FIRED, because they gate on
-- runs.attempt_number >= briefs.max_attempts and attempt_number was stuck at 1 on
-- every Run. Root cause: the live major.claim_next_brief body was still the
-- pre-ADR-014 version from 20260512000001_rpc_v2_stream_b — it inserts a Run row
-- WITHOUT attempt_number and WITHOUT a computed purpose, so both took their column
-- defaults (attempt_number=1, purpose='execute') on every claim. The ADR-014
-- computation in 20260516000000 was merged to the repo but never effectively applied
-- to the live `major` schema on the dev Supabase project (nuihvxluxdpdjgkvtdih).
--
-- Evidence (live, 2026-05-25): Brief 72 accrued 21 Runs, EVERY one
-- attempt_number=1 / purpose='execute' / started_against_revision_id=65, against a
-- single content revision (65). Under the 20260516000000 body the 2nd+ Runs would be
-- attempt_number=2,3 / purpose='repair'; neither appeared → the stale body is live.
--
-- Why a NEW migration instead of re-running 20260516000000: the dev project's
-- schema_migrations history is shared with HealthBite and unreliable — it already
-- carries a row for 20260516000000, so `supabase db push` will not re-run that
-- version even though its body never took. A fresh, monotonically-later version
-- number (this file) is guaranteed to run. See the redeploy recipe referenced in
-- docs/runbook.md.
--
-- Signature is unchanged from 20260512000001 / 20260516000000 (5 params:
-- text, bigint, integer, text, text), so this is a CREATE OR REPLACE — no DROP, and
-- the only caller (the major-claim-brief edge function) is unaffected.
--
-- Semantics note (deliberate): attempt_number is computed as (latest COMPLETED Run's
-- attempt_number + 1), NOT max(attempt_number) over all Runs. The latest-run basis is
-- what makes the ADR-014 "reset on new Content Revision" rule work: after a reset to 1
-- on a newer revision, the next attempt must continue 1→2→3 from the post-reset Run,
-- which max() would break by carrying the pre-reset peak forward.
--
-- Depends on:
--   * 20260510000001_run_retry_budget.sql   (briefs.max_attempts, runs.attempt_number)
--   * 20260512000001_rpc_v2_stream_b.sql     (the stale body this supersedes)
--   * 20260516000000_claim_brief_repair_purpose.sql (the body re-asserted here)
--   * initial schema runs.inspected_run_id   (nullable FK, set when purpose=repair)

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

-- Grant is identical to the previous migrations; re-state to keep it in sync.
grant execute on function major.claim_next_brief(text, bigint, integer, text, text) to service_role;

commit;
