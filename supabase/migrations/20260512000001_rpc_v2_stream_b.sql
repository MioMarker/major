-- 20260512000001_rpc_v2_stream_b.sql
-- Stream B RPC correctness + atomicity fixes: Brief 62, Plan 001 §3 Stream B.
--
-- Rewrites all four core RPCs (claim_next_brief, finalize_run,
-- apply_change_set, reaper_sweep) with the following fixes:
--
-- claim_next_brief (F-06, F-07):
--   - Idempotent retry: if a Run with (shell_id, claim_idempotency_key) already
--     exists, return it without creating a duplicate.
--   - Skip Briefs that have an active auto_triage_requests row (status in
--     'requested' or 'running') so the auto-triage loop and the execute loop
--     don't race on the same Brief.
--   - Persist claim_idempotency_key on the inserted Run row.
--
-- finalize_run (F-11, F-12, F-13):
--   - New parameter p_caller_shell_id (default null): if provided, the caller's
--     shell_id must match the Run's shell_id or the RPC raises an exception.
--     Prevents a slow-running Shell from corrupting a re-claimed Run. Until
--     Stream C updates the edge function to pass this argument, the default null
--     bypasses the check and existing callers are unaffected.
--   - Idempotent retry: if a 'run-ended' event with the same idempotency key
--     already exists, return the brief_id/run_id pair immediately without
--     re-applying any state changes.
--   - State guard: raise an exception if the Run is not in 'running' outcome
--     (prevents finalization of a run that was already cancelled by the Reaper).
--   - Transition validation: raise an exception if p_next_status is not a legal
--     successor of the Brief's current status per the SPEC lifecycle matrix.
--   - ON CONFLICT (idempotency_key) DO NOTHING on all three event inserts so
--     genuine retries with the same key silently no-op instead of throwing.
--   - ON CONFLICT DO NOTHING on brief_artifact inserts using the unique index
--     added in 20260512000000 (idx_brief_artifacts_dedup).
--
-- apply_change_set (F-22, ADR 018):
--   - Transition validation for 'transition-brief' and 'set-ready-state' ops:
--     raise an exception if the requested transition is not permitted by the
--     SPEC lifecycle matrix. The validation only fires when the Brief is found;
--     camelCase payloads (which resolve to NULL brief_id) continue to no-op
--     as before (acceptance criterion preserved).
--
-- reaper_sweep: no changes; included verbatim so all four grants stay in sync.
--
-- Depends on: 20260512000000_stream_b_schema.sql (adds claim_idempotency_key
-- column and idx_brief_artifacts_dedup index).

set search_path = major, public;

begin;

-- ═══════════════════════════════════════════════════════════════
-- Drop finalize_run before recreating with new signature (adding
-- p_caller_shell_id). PostgreSQL CREATE OR REPLACE cannot change
-- the parameter list; drop + create is required.
-- ═══════════════════════════════════════════════════════════════

drop function if exists major.finalize_run(
  bigint, text, text, text, text, text, jsonb, jsonb, text,
  integer, integer, text, integer, integer, integer, integer
);

-- ═══════════════════════════════════════════════════════════════
-- claim_next_brief — Run Start Transaction (v2)
-- ═══════════════════════════════════════════════════════════════

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
  v_brief_id   bigint;
  v_revision   bigint;
  v_run_id     bigint;
  v_lease      timestamptz := now() + (p_lease_minutes || ' minutes')::interval;
  v_idem       text := coalesce(p_idempotency_key, gen_random_uuid()::text);
begin
  -- Idempotent-retry: if this Shell already claimed a Brief under this key,
  -- return the existing Run instead of creating a duplicate (F-06).
  select r.brief_id, r.id, r.started_against_revision_id
  into v_brief_id, v_run_id, v_revision
  from major.runs r
  where r.shell_id = p_shell_id
    and r.claim_idempotency_key = v_idem
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

  update major.briefs
  set status = 'agent-running'
  where id = v_brief_id;

  insert into major.runs (
    brief_id, purpose, outcome, shell_id,
    started_against_revision_id, claimed_at, lease_expires_at, heartbeat_at,
    claim_idempotency_key
  ) values (
    v_brief_id, p_purpose, 'running', p_shell_id,
    v_revision, now(), v_lease, now(),
    v_idem
  )
  returning id into v_run_id;

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, v_run_id, 'run-started', 'shell:' || p_shell_id,
    jsonb_build_object('purpose', p_purpose, 'lease_expires_at', v_lease),
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

-- ═══════════════════════════════════════════════════════════════
-- finalize_run — Run Finalization Transaction (v2)
-- ═══════════════════════════════════════════════════════════════
--
-- New parameter p_caller_shell_id (default null):
--   Pass the calling Shell's id to enable the ownership guard. Existing
--   callers that omit the argument get null and the guard is bypassed;
--   this keeps the edge function (Stream C) as a non-blocking follow-on.

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
  v_brief_id    bigint;
  v_shell_id    text;
  v_outcome     text;
  v_prev_status text;
  v_idem        text := coalesce(p_idempotency_key, gen_random_uuid()::text);
  vr            jsonb;
  ar            jsonb;
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

  -- Lock the run row and capture ownership + outcome for guards below.
  select runs.brief_id, runs.shell_id, runs.outcome
  into v_brief_id, v_shell_id, v_outcome
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
  select status into v_prev_status
  from major.briefs
  where id = v_brief_id
  for update;

  -- Transition validation: p_next_status must be a legal successor of the
  -- brief's current status per the SPEC lifecycle state machine.
  if p_next_status not in (
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
      v_prev_status, p_next_status, v_brief_id;
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

  -- Step 4: transition the brief.
  update major.briefs
  set status = p_next_status
  where id = v_brief_id;

  -- Step 5: emit lifecycle events. ON CONFLICT DO NOTHING ensures genuine
  -- retries with the same idempotency key silently no-op (F-12).
  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'run-ended', p_actor,
    jsonb_build_object('outcome', p_outcome, 'cancellation_reason', p_cancellation_reason),
    'run-ended:' || p_run_id::text || ':' || v_idem
  )
  on conflict (idempotency_key) do nothing;

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'status-transitioned', p_actor,
    jsonb_build_object('from', v_prev_status, 'to', p_next_status),
    'status-transitioned:' || p_run_id::text || ':' || v_idem
  )
  on conflict (idempotency_key) do nothing;

  if p_next_status = 'ready-for-human' then
    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_brief_id, p_run_id, 'human-handoff', p_actor,
      jsonb_build_object('reason', coalesce(p_handoff_reason, 'unspecified')),
      'human-handoff:' || p_run_id::text || ':' || v_idem
    )
    on conflict (idempotency_key) do nothing;
  end if;

  brief_id := v_brief_id;
  run_id   := p_run_id;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- apply_change_set — Triage Change Set application (v2)
-- ═══════════════════════════════════════════════════════════════
--
-- Includes all changes from 20260511000002 (auto brief ref, __auto__
-- placeholder, source-tracing fields on create-brief), plus:
--
-- F-22 transition validation on 'transition-brief' and 'set-ready-state':
--   Raises an exception if the requested target status is not a valid
--   successor of the Brief's current status per the SPEC lifecycle matrix.
--   Only fires when the Brief is found; camelCase payloads (brief_id key
--   absent → NULL cast → 0-row query → NOT FOUND) continue to no-op.

create or replace function major.apply_change_set(
  p_change_set_id    bigint,
  p_actor            text,
  p_idempotency_root text default null
)
returns table (
  applied_op_count integer,
  failed_op_id     bigint,
  failure_message  text
) language plpgsql security definer as $$
declare
  v_op             record;
  v_payload        jsonb;
  v_count          integer := 0;
  v_idem_root      text    := coalesce(p_idempotency_root, p_change_set_id::text);
  v_new_brief_id   bigint;
  v_new_revision   bigint;
  v_existing_max   integer;
  v_current_status text;
  v_target_status  text;
begin
  for v_op in
    select id, operation_type, payload, sequence_index
    from major.triage_change_operations
    where change_set_id = p_change_set_id
      and status in ('proposed', 'accepted')
    order by sequence_index asc
    for update
  loop
    v_payload := v_op.payload;

    -- Resolve the __auto__ placeholder: if the payload's brief_id is the
    -- sentinel "__auto__", substitute the id of the Brief most recently
    -- created in this same change set by a create-brief op.
    if v_new_brief_id is not null and (v_payload->>'brief_id') = '__auto__' then
      v_payload := jsonb_set(v_payload, '{brief_id}', to_jsonb(v_new_brief_id));
    end if;

    if v_op.operation_type = 'create-brief' then
      insert into major.briefs (
        status, classifications, expected_artifact_type, expected_paths,
        git_repository_ref, base_branch, queue_rank, priority_class, placement_reason,
        source_session_id, source_issue_repo, source_issue_number
      ) values (
        'ready-for-triage',
        coalesce((v_payload->'classifications')::text[]::text[], '{}'),
        v_payload->>'expected_artifact_type',
        coalesce(array(select jsonb_array_elements_text(v_payload->'expected_paths')), '{}'),
        v_payload->>'git_repository_ref',
        coalesce(v_payload->>'base_branch', 'dev'),
        nullif((v_payload->>'queue_rank'), '')::integer,
        v_payload->>'priority_class',
        v_payload->>'placement_reason',
        nullif((v_payload->>'source_session_id'), '')::bigint,
        v_payload->>'source_issue_repo',
        nullif((v_payload->>'source_issue_number'), '')::integer
      )
      returning id into v_new_brief_id;

      if v_payload ? 'content_md' then
        insert into major.brief_content_revisions (
          brief_id, revision_number, content_md, author_actor, reason
        ) values (
          v_new_brief_id, 1, v_payload->>'content_md', p_actor, 'create-brief'
        )
        returning id into v_new_revision;

        update major.briefs set current_revision_id = v_new_revision where id = v_new_brief_id;
      end if;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        v_new_brief_id, 'brief-created', p_actor,
        jsonb_build_object('change_set_id', p_change_set_id, 'sequence_index', v_op.sequence_index),
        'brief-created:' || v_new_brief_id::text || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now(),
          resulting_record_ref = jsonb_build_object('brief_id', v_new_brief_id, 'revision_id', v_new_revision)
      where id = v_op.id;

    elsif v_op.operation_type = 'add-content-revision' then
      select coalesce(max(revision_number), 0) into v_existing_max
      from major.brief_content_revisions
      where brief_id = (v_payload->>'brief_id')::bigint;

      insert into major.brief_content_revisions (
        brief_id, revision_number, content_md, author_actor, reason
      ) values (
        (v_payload->>'brief_id')::bigint,
        v_existing_max + 1,
        v_payload->>'content_md',
        p_actor,
        v_payload->>'reason'
      )
      returning id into v_new_revision;

      update major.briefs
      set current_revision_id = v_new_revision
      where id = (v_payload->>'brief_id')::bigint;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'brief_id')::bigint, 'content-revision-added', p_actor,
        jsonb_build_object('revision_id', v_new_revision, 'reason', v_payload->>'reason'),
        'content-revision-added:' || v_new_revision::text || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now(),
          resulting_record_ref = jsonb_build_object('revision_id', v_new_revision)
      where id = v_op.id;

    elsif v_op.operation_type = 'set-classifications' then
      update major.briefs
      set classifications = coalesce(array(select jsonb_array_elements_text(v_payload->'classifications')), '{}')
      where id = (v_payload->>'brief_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'add-relationship' then
      insert into major.brief_relationships (
        parent_id, child_id, type, parent_review_requirement
      ) values (
        (v_payload->>'parent_id')::bigint,
        (v_payload->>'child_id')::bigint,
        v_payload->>'type',
        coalesce(v_payload->>'parent_review_requirement', 'required')
      )
      on conflict (parent_id, child_id, type) do nothing;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'child_id')::bigint, 'relationship-added', p_actor,
        v_payload,
        'relationship-added:' || (v_payload->>'parent_id') || ':' || (v_payload->>'child_id') || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-parent-review-requirement' then
      update major.brief_relationships
      set parent_review_requirement = v_payload->>'value',
          excluded_reason           = v_payload->>'reason',
          excluded_by_actor         = p_actor
      where id = (v_payload->>'relationship_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'record-git-branch' then
      update major.briefs
      set git_branch  = v_payload->>'git_branch',
          base_branch = coalesce(v_payload->>'base_branch', base_branch)
      where id = (v_payload->>'brief_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-ready-state' then
      -- Resolve target status from the payload's 'ready' boolean.
      v_target_status := case when (v_payload->>'ready')::boolean
                              then 'ready-for-agent' else 'ready-for-triage' end;

      -- Transition validation (F-22): only fires when the Brief exists.
      -- camelCase payloads resolve to NULL brief_id → 0-row query → NOT FOUND
      -- → validation skipped → UPDATE affects 0 rows → silent no-op (as before).
      select status into v_current_status
      from major.briefs where id = (v_payload->>'brief_id')::bigint;

      if found then
        if v_target_status not in (
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
          where from_status = v_current_status
        ) then
          raise exception 'invalid transition from % to % for brief %',
            v_current_status, v_target_status, v_payload->>'brief_id';
        end if;
      end if;

      update major.briefs
      set status = v_target_status
      where id = (v_payload->>'brief_id')::bigint;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'brief_id')::bigint, 'status-transitioned', p_actor,
        v_payload,
        'status-transitioned-srs:' || (v_payload->>'brief_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-queue-rank' then
      update major.briefs
      set queue_rank       = nullif(v_payload->>'queue_rank', '')::integer,
          priority_class   = v_payload->>'priority_class',
          placement_reason = v_payload->>'placement_reason'
      where id = (v_payload->>'brief_id')::bigint;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'brief_id')::bigint, 'queue-rank-set', p_actor,
        v_payload,
        'queue-rank-set:' || (v_payload->>'brief_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'transition-brief' then
      -- Transition validation (F-22): only fires when the Brief exists.
      -- camelCase payloads resolve to NULL brief_id → NOT FOUND → validation
      -- skipped → UPDATE affects 0 rows → silent no-op (acceptance criterion).
      select status into v_current_status
      from major.briefs where id = (v_payload->>'brief_id')::bigint;

      if found then
        if v_payload->>'to_status' not in (
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
          where from_status = v_current_status
        ) then
          raise exception 'invalid transition from % to % for brief %',
            v_current_status, v_payload->>'to_status', v_payload->>'brief_id';
        end if;
      end if;

      update major.briefs
      set status = v_payload->>'to_status'
      where id = (v_payload->>'brief_id')::bigint;

      insert into major.events (brief_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'brief_id')::bigint, 'status-transitioned', p_actor,
        v_payload,
        'status-transitioned-tb:' || (v_payload->>'brief_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    else
      raise exception 'unknown operation_type %', v_op.operation_type;
    end if;

    v_count := v_count + 1;
  end loop;

  update major.triage_change_sets
  set decision = 'accepted', decision_actor = p_actor, decided_at = now()
  where id = p_change_set_id;

  applied_op_count := v_count;
  failed_op_id     := null;
  failure_message  := null;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- reaper_sweep — lease-expired Run cancellation (unchanged)
-- ═══════════════════════════════════════════════════════════════
-- Included verbatim so grants for all four functions remain in sync.
-- No logic changes; already has ON CONFLICT DO NOTHING on both event
-- inserts and correctly references the post-GITS-rename column names.

create or replace function major.reaper_sweep()
returns table (cancelled_runs integer, briefs_returned integer)
language plpgsql security definer as $$
declare
  v_run       record;
  v_cancelled integer := 0;
  v_returned  integer := 0;
begin
  for v_run in
    select id, brief_id, shell_id
    from major.runs
    where outcome = 'running' and lease_expires_at < now()
    for update skip locked
  loop
    update major.runs
    set outcome             = 'cancelled',
        cancellation_reason = 'lease-expired',
        ended_at            = now()
    where id = v_run.id;
    v_cancelled := v_cancelled + 1;

    update major.briefs
    set status = 'ready-for-agent'
    where id = v_run.brief_id and status = 'agent-running';
    v_returned := v_returned + 1;

    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.brief_id, v_run.id, 'run-ended', 'major:reaper',
      jsonb_build_object('outcome', 'cancelled', 'cancellation_reason', 'lease-expired'),
      'run-ended-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.brief_id, v_run.id, 'status-transitioned', 'major:reaper',
      jsonb_build_object('from', 'agent-running', 'to', 'ready-for-agent', 'reason', 'lease-expired'),
      'status-transitioned-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into major.telemetry_records (brief_id, run_id, observation_type, payload)
    values (
      v_run.brief_id, v_run.id, 'repair-inspection-trigger',
      jsonb_build_object('reason', 'lease-expired', 'shell_id', v_run.shell_id)
    );
  end loop;

  cancelled_runs  := v_cancelled;
  briefs_returned := v_returned;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Grants
-- ═══════════════════════════════════════════════════════════════

grant execute on function major.claim_next_brief(text, bigint, integer, text, text) to service_role;

-- finalize_run now has 17 parameters (16 original + p_caller_shell_id).
grant execute on function major.finalize_run(
  bigint, text, text, text, text, text, jsonb, jsonb, text,
  integer, integer, text, integer, integer, integer, integer,
  text
) to service_role;

grant execute on function major.apply_change_set(bigint, text, text) to service_role;
grant execute on function major.reaper_sweep() to service_role;

commit;
