-- 20260525000002_finalize_run_enforce_retry_budget.sql
-- Implements docs/adr/014-run-retry-budget.md (server-side enforcement) and
-- docs/runbook.md §2.9 ("On Run Finalization ... if attempt_number < max_attempts
-- the Brief is re-armed to ready-for-agent; if attempt_number >= max_attempts it
-- is routed to ready-for-human with retry_budget_exhausted: true").
--
-- INCIDENT (2026-05-25): a batch of failed Runs re-armed their Briefs to
-- ready-for-agent unbounded (27 runs / 22 failed / 5–6 retries per Brief, zero
-- successes). Root cause: the live finalize_run (20260512000001_rpc_v2_stream_b)
-- never reads runs.attempt_number / briefs.max_attempts — it blindly applies the
-- caller-supplied p_next_status. The Shell passes p_next_status='ready-for-agent'
-- on every failed Run, so the retry cap from ADR 014 was never enforced and the
-- Brief looped forever.
--
-- ADR 014 sketched the auto-retry decision living in shell/main.ts. The runbook
-- §2.9 (the operator-facing contract) and this incident make the cap a Cyberbrain
-- invariant: a failed Run that asks to re-arm above budget MUST instead park at
-- ready-for-human. Enforcing it in finalize_run closes the loop regardless of what
-- the Shell requests (Hard Rule #1 — the Cyberbrain is authoritative). The Shell
-- still computes its own intent; this is the server-side backstop the runbook
-- describes, not a relocation of policy away from the Shell.
--
-- This migration CREATE OR REPLACEs finalize_run with ONLY the failure-branch cap
-- added. Signature is unchanged from 20260512000001 (17 params), so no drop is
-- needed and existing callers (the major-finalize-run edge function) are
-- unaffected. Every other duty of the v2 RPC is preserved verbatim: idempotent
-- retry, ownership guard, state guard, transition validation, run-row metric
-- hoist, verification_results upsert, brief_artifacts dedup insert, the success
-- path (ready-for-review), and all event idempotency keys.
--
-- The cap:
--   When p_outcome = 'failed' AND the caller asked to re-arm
--   (p_next_status = 'ready-for-agent') AND the failing Run's attempt_number
--   >= the Brief's max_attempts, the effective next status is overridden to
--   'ready-for-human' and the human-handoff Event payload carries
--   retry_budget_exhausted: true. Below budget, the re-arm is honored unchanged
--   (claim_next_brief, per 20260516000000, then claims it as a Repair Run).
--
-- The columns this reads already exist (20260510000001_run_retry_budget.sql):
--   * major.briefs.max_attempts   integer not null default 3
--   * major.runs.attempt_number   integer not null default 1
-- They are re-asserted with `add column if not exists` below for idempotency /
-- defense-in-depth; the statements are no-ops on the live DB where they exist.
--
-- Depends on:
--   * 20260510000001_run_retry_budget.sql   (max_attempts, attempt_number columns)
--   * 20260512000001_rpc_v2_stream_b.sql    (the finalize_run body this supersedes)

set search_path = major, public;

begin;

-- Defensive: ensure the budget columns exist before the RPC references them.
-- No-ops on the live dev DB (added by 20260510000001); present so this migration
-- is self-contained and idempotent per .claude/rules/db/migrations.md.
alter table major.briefs
  add column if not exists max_attempts integer not null default 3;

alter table major.runs
  add column if not exists attempt_number integer not null default 1;

-- ═══════════════════════════════════════════════════════════════
-- finalize_run — Run Finalization Transaction (v3)
-- ═══════════════════════════════════════════════════════════════
--
-- Identical to the v2 body (20260512000001) except for the retry-budget cap
-- applied to the failure branch. Signature unchanged → CREATE OR REPLACE (no
-- drop). p_next_status remains the caller's *requested* next status; the RPC
-- now derives an *effective* next status (v_effective_status) that may override
-- 'ready-for-agent' → 'ready-for-human' when the budget is exhausted on a failed
-- Run. All transition validation, persistence, and events use the effective
-- status so the audit trail reflects what actually happened.

create or replace function major.finalize_run(
  p_run_id               bigint,
  p_outcome              text,
  p_next_status          text,
  p_actor                text,
  p_handoff_reason       text    default null,
  p_cancellation_reason  text    default null,
  p_verification_results jsonb   default '[]'::jsonb,
  p_artifacts            jsonb   default '[]'::jsonb,
  p_idempotency_key      text    default null,
  p_num_turns            integer default null,
  p_duration_ms          integer default null,
  p_final_text           text    default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_cache_read_tokens    integer default null,
  p_cache_write_tokens   integer default null,
  p_caller_shell_id      text    default null
)
returns table (brief_id bigint, run_id bigint)
language plpgsql security definer as $$
#variable_conflict use_column
declare
  v_brief_id        bigint;
  v_shell_id        text;
  v_outcome         text;
  v_prev_status     text;
  v_idem            text := coalesce(p_idempotency_key, gen_random_uuid()::text);
  vr                jsonb;
  ar                jsonb;
  -- ADR 014 retry-budget enforcement state.
  v_attempt_number  integer;
  v_max_attempts    integer;
  v_budget_exhausted boolean := false;
  v_effective_status text   := p_next_status;
  v_handoff_reason   text   := p_handoff_reason;
begin
  -- Idempotent-retry: if a 'run-ended' event with this key already exists,
  -- the finalization already completed. Return the IDs without re-applying
  -- any state changes (F-12).
  select r.brief_id
  into v_brief_id
  from major.runs r
  where r.id = p_run_id
    and exists (
      select 1 from major.events e
      where e.idempotency_key = 'run-ended:' || p_run_id::text || ':' || v_idem
        and e.type = 'run-ended'
    );

  if found then
    brief_id := v_brief_id;
    run_id   := p_run_id;
    return next;
    return;
  end if;

  -- Lock the run row and capture ownership + outcome + attempt for guards below.
  select runs.brief_id, runs.shell_id, runs.outcome, runs.attempt_number
  into v_brief_id, v_shell_id, v_outcome, v_attempt_number
  from major.runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'run % not found', p_run_id;
  end if;

  -- Ownership guard (F-11): if the caller identifies itself, verify it owns
  -- the Run. Prevents a slow-running Shell from corrupting a re-claimed Run.
  if p_caller_shell_id is not null and v_shell_id is distinct from p_caller_shell_id then
    raise exception 'run % is owned by shell %, caller is %',
      p_run_id, v_shell_id, p_caller_shell_id;
  end if;

  -- State guard: run must still be in 'running' outcome. If the Reaper already
  -- cancelled it, this call must fail rather than overwrite the cancelled state.
  if v_outcome <> 'running' then
    raise exception 'run % already finalized (outcome=%)', p_run_id, v_outcome;
  end if;

  -- Lock the brief and capture current status for transition validation.
  -- max_attempts is read under the same lock for the retry-budget cap.
  select status, max_attempts
  into v_prev_status, v_max_attempts
  from major.briefs
  where id = v_brief_id
  for update;

  -- ── ADR 014 / runbook §2.9: retry-budget cap on the failure branch ──────────
  --
  -- A failed Run that the caller wants to re-arm (p_next_status='ready-for-agent')
  -- is honored ONLY while the failing attempt is below the Brief's max_attempts.
  -- At or above the cap, override the effective next status to 'ready-for-human'
  -- so the auto-retry loop terminates and a human becomes the backstop. The
  -- human-handoff Event (emitted below for any ready-for-human transition) carries
  -- retry_budget_exhausted: true so operators can filter for this disposition.
  --
  -- Scope: this only intercepts the auto-retry re-arm. Success (ready-for-review),
  -- explicit human handoff (p_next_status already 'ready-for-human'), and
  -- cancellation dispositions are untouched. attempt_number is computed at claim
  -- time by claim_next_brief (20260516000000); a human "Re-arm as Repair" override
  -- pushes attempt_number past max_attempts deliberately and is governed by the
  -- human decision, not this cap (runbook §2.9).
  if p_outcome = 'failed'
     and p_next_status = 'ready-for-agent'
     and v_attempt_number >= v_max_attempts then
    v_budget_exhausted := true;
    v_effective_status := 'ready-for-human';
    v_handoff_reason   := coalesce(
      p_handoff_reason,
      'retry budget exhausted: attempt ' || v_attempt_number::text
        || ' of max ' || v_max_attempts::text
    );
  end if;
  -- ────────────────────────────────────────────────────────────────────────────

  -- Transition validation: v_effective_status must be a legal successor of the
  -- brief's current status per the SPEC lifecycle state machine. Validate the
  -- EFFECTIVE status (post-cap) so an overridden ready-for-human is checked, and
  -- an above-budget re-arm can never slip through as ready-for-agent.
  if v_effective_status not in (
    select unnest(allowed)
    from (values
      ('ready-for-triage',  array['needs-info','ready-for-agent','wontfix']::text[]),
      ('needs-info',        array['ready-for-triage','wontfix']::text[]),
      ('ready-for-agent',   array['agent-running','ready-for-triage','needs-info','wontfix']::text[]),
      ('agent-running',     array['ready-for-review','ready-for-human','ready-for-agent','wontfix']::text[]),
      ('ready-for-review',  array['ready-for-human','done','merge-blocked','wontfix']::text[]),
      ('ready-for-human',   array['done','wontfix','ready-for-triage','ready-for-agent']::text[]),
      ('merge-blocked',     array['ready-for-review','done','wontfix']::text[]),
      ('done',              array[]::text[]),
      ('wontfix',           array[]::text[])
    ) as t(from_status, allowed)
    where from_status = v_prev_status
  ) then
    raise exception 'invalid transition from % to % for brief %',
      v_prev_status, v_effective_status, v_brief_id;
  end if;

  -- Step 1: finalize the run row and hoist summary metrics.
  update major.runs
  set outcome             = p_outcome,
      cancellation_reason = p_cancellation_reason,
      ended_at            = now(),
      num_turns           = p_num_turns,
      duration_ms         = p_duration_ms,
      final_text          = p_final_text,
      input_tokens        = p_input_tokens,
      output_tokens       = p_output_tokens,
      cache_read_tokens   = p_cache_read_tokens,
      cache_write_tokens  = p_cache_write_tokens
  where id = p_run_id;

  -- Step 2: insert verification_results.
  for vr in
    select * from jsonb_array_elements(coalesce(p_verification_results, '[]'::jsonb))
  loop
    insert into major.verification_results (
      run_id, check_name, outcome, required, requiredness_source, payload
    ) values (
      p_run_id,
      vr->>'check_name',
      vr->>'outcome',
      coalesce((vr->>'required')::boolean, false),
      vr->>'requiredness_source',
      coalesce(vr->'payload', '{}'::jsonb)
    )
    on conflict (run_id, check_name) do update
      set outcome             = excluded.outcome,
          required            = excluded.required,
          requiredness_source = excluded.requiredness_source,
          payload             = excluded.payload;
  end loop;

  -- Step 3: insert brief_artifacts. ON CONFLICT DO NOTHING deduplicates rows
  -- covered by idx_brief_artifacts_dedup (rows with non-null external_ref)
  -- on genuine retries (F-13).
  for ar in
    select * from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb))
  loop
    insert into major.brief_artifacts (
      brief_id, run_id, artifact_type, external_ref, payload
    ) values (
      v_brief_id,
      p_run_id,
      ar->>'artifact_type',
      ar->>'external_ref',
      coalesce(ar->'payload', '{}'::jsonb)
    )
    on conflict do nothing;
  end loop;

  -- Step 4: transition the brief to the EFFECTIVE next status (post-cap).
  update major.briefs
  set status = v_effective_status
  where id = v_brief_id;

  -- Step 5: emit lifecycle events. ON CONFLICT DO NOTHING ensures genuine
  -- retries with the same idempotency key silently no-op (F-12).
  -- run-ended carries retry_budget_exhausted so the disposition is on the Run's
  -- terminal event too, not only the human-handoff Event.
  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'run-ended', p_actor,
    jsonb_build_object(
      'outcome', p_outcome,
      'cancellation_reason', p_cancellation_reason,
      'retry_budget_exhausted', v_budget_exhausted
    ),
    'run-ended:' || p_run_id::text || ':' || v_idem
  )
  on conflict (idempotency_key) do nothing;

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'status-transitioned', p_actor,
    jsonb_build_object('from', v_prev_status, 'to', v_effective_status),
    'status-transitioned:' || p_run_id::text || ':' || v_idem
  )
  on conflict (idempotency_key) do nothing;

  -- Human-handoff Event fires for any ready-for-human transition — whether the
  -- caller requested it directly or the retry-budget cap forced it. When the cap
  -- forced it, payload.retry_budget_exhausted = true (runbook §2.9) and carries
  -- attempt_number / max_attempts so operators can see how the budget was spent.
  if v_effective_status = 'ready-for-human' then
    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_brief_id, p_run_id, 'human-handoff', p_actor,
      jsonb_build_object(
        'reason', coalesce(v_handoff_reason, 'unspecified'),
        'retry_budget_exhausted', v_budget_exhausted,
        'attempt_number', v_attempt_number,
        'max_attempts', v_max_attempts
      ),
      'human-handoff:' || p_run_id::text || ':' || v_idem
    )
    on conflict (idempotency_key) do nothing;
  end if;

  brief_id := v_brief_id;
  run_id   := p_run_id;
  return next;
end;
$$;

-- Re-state the grant (signature unchanged: 17 params). Idempotent.
grant execute on function major.finalize_run(
  bigint, text, text, text, text, text, jsonb, jsonb, text,
  integer, integer, text, integer, integer, integer, integer,
  text
) to service_role;

commit;
