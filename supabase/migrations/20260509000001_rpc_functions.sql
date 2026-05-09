-- functions/_sql/rpc_functions.sql
--
-- Postgres functions called from edge functions to perform multi-statement
-- atomic operations (Run Start Transaction, Run Finalization Transaction,
-- Change Set apply). Edge functions rely on these RPCs because the supabase
-- client cannot wrap multiple statements in a single round-tripped
-- transaction; an RPC body is one transaction by default.
--
-- This file is OWNED by the functions/ directory (in the v1 split, Agent A
-- owns db/ for the *schema*, Agent B owns these RPCs as part of the API
-- surface). To deploy:
--
--     SUPABASE_DB_PASSWORD=... npx -y supabase db execute --file functions/_sql/rpc_functions.sql
--
-- All functions live under the `major` schema and have SECURITY DEFINER so
-- they execute with the role that owns them (typically the service-role
-- shadow role) — never the caller. Edge functions reach them via
-- `supabase.rpc('major_<name>', { ... })`.

set search_path = major, public;

-- ═══════════════════════════════════════════════════════════════
-- claim_next_item — Run Start Transaction
-- ═══════════════════════════════════════════════════════════════
--
-- Atomically:
--   1. Pick the highest-priority Runner-Eligible Work Item (status =
--      ready-for-agent, not blocked, with FOR UPDATE SKIP LOCKED).
--   2. Transition it to agent-running.
--   3. Insert a new running Run.
--   4. Insert a `run-started` Event.
--
-- Returns the picked Item id, the Run id, and the started-against revision id.
-- Returns NULL row if nothing was claimable.
create or replace function major.claim_next_item(
  p_runner_id          text,
  p_specific_item_id   bigint default null,
  p_lease_minutes      integer default 5,
  p_purpose            text default 'execute',
  p_idempotency_key    text default null
)
returns table (
  item_id            bigint,
  run_id             bigint,
  revision_id        bigint
) language plpgsql security definer as $$
declare
  v_item_id    bigint;
  v_revision   bigint;
  v_run_id     bigint;
  v_lease      timestamptz := now() + (p_lease_minutes || ' minutes')::interval;
  v_idem       text := coalesce(p_idempotency_key, gen_random_uuid()::text);
begin
  -- Select target item id with row lock; SKIP LOCKED loses to a concurrent
  -- claimer cleanly (returns no row, caller polls again).
  if p_specific_item_id is not null then
    select id into v_item_id
    from major.work_items
    where id = p_specific_item_id
      and status = 'ready-for-agent'
      and not exists (
        select 1 from major.work_item_relationships r
        join major.work_items w on w.id = r.parent_id
        where r.child_id = work_items.id
          and r.type = 'blocks'
          and w.status not in ('done', 'wontfix')
      )
    for update skip locked;
  else
    select id into v_item_id
    from major.work_items
    where status = 'ready-for-agent'
      and not exists (
        select 1 from major.work_item_relationships r
        join major.work_items w on w.id = r.parent_id
        where r.child_id = work_items.id
          and r.type = 'blocks'
          and w.status not in ('done', 'wontfix')
      )
    order by queue_rank asc nulls last, created_at asc
    for update skip locked
    limit 1;
  end if;

  if v_item_id is null then
    return; -- empty result set; caller returns 409 to runner
  end if;

  -- Capture the current Content Revision so the Run is bound to a specific PRD version.
  select current_revision_id into v_revision
  from major.work_items
  where id = v_item_id;

  update major.work_items
  set status = 'agent-running'
  where id = v_item_id;

  insert into major.runs (
    work_item_id, purpose, outcome, runner_id,
    started_against_revision_id, claimed_at, lease_expires_at, heartbeat_at
  ) values (
    v_item_id, p_purpose, 'running', p_runner_id,
    v_revision, now(), v_lease, now()
  )
  returning id into v_run_id;

  insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_item_id, v_run_id, 'run-started', 'runner:' || p_runner_id,
    jsonb_build_object('purpose', p_purpose, 'lease_expires_at', v_lease),
    'run-started:' || v_run_id::text || ':' || v_idem
  );

  insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_item_id, v_run_id, 'status-transitioned', 'runner:' || p_runner_id,
    jsonb_build_object('from', 'ready-for-agent', 'to', 'agent-running'),
    'status-transitioned:' || v_run_id::text || ':' || v_idem
  );

  item_id := v_item_id;
  run_id  := v_run_id;
  revision_id := v_revision;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- finalize_run — Run Finalization Transaction
-- ═══════════════════════════════════════════════════════════════
--
-- Atomically:
--   1. UPDATE the run row (outcome, ended_at, cancellation_reason).
--   2. INSERT verification_results (per check_name).
--   3. INSERT work_item_artifacts (per artifact ref).
--   4. UPDATE work_items.status to next_status.
--   5. INSERT events (run-ended, status-transitioned, plus optional
--      human-handoff or accepted).
create or replace function major.finalize_run(
  p_run_id              bigint,
  p_outcome             text,
  p_next_status         text,
  p_actor               text,
  p_handoff_reason      text default null,
  p_cancellation_reason text default null,
  p_verification_results jsonb default '[]'::jsonb,
  p_artifacts           jsonb default '[]'::jsonb,
  p_idempotency_key     text default null
)
returns table (item_id bigint, run_id bigint) language plpgsql security definer as $$
declare
  v_item_id    bigint;
  v_prev_status text;
  v_idem       text := coalesce(p_idempotency_key, gen_random_uuid()::text);
  vr           jsonb;
  ar           jsonb;
begin
  -- Lock the run row + parent item.
  select work_item_id into v_item_id from major.runs where id = p_run_id for update;
  if v_item_id is null then
    raise exception 'run % not found', p_run_id;
  end if;

  select status into v_prev_status from major.work_items where id = v_item_id for update;

  update major.runs
  set outcome = p_outcome,
      cancellation_reason = p_cancellation_reason,
      ended_at = now()
  where id = p_run_id;

  -- Insert verification_results. Each entry: { check_name, outcome, required, requiredness_source, payload }
  for vr in select * from jsonb_array_elements(coalesce(p_verification_results, '[]'::jsonb))
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
      set outcome = excluded.outcome,
          required = excluded.required,
          requiredness_source = excluded.requiredness_source,
          payload = excluded.payload;
  end loop;

  -- Insert work_item_artifacts.
  for ar in select * from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb))
  loop
    insert into major.work_item_artifacts (
      work_item_id, run_id, artifact_type, external_ref, payload
    ) values (
      v_item_id,
      p_run_id,
      ar->>'artifact_type',
      ar->>'external_ref',
      coalesce(ar->'payload', '{}'::jsonb)
    );
  end loop;

  update major.work_items set status = p_next_status where id = v_item_id;

  insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_item_id, p_run_id, 'run-ended', p_actor,
    jsonb_build_object('outcome', p_outcome, 'cancellation_reason', p_cancellation_reason),
    'run-ended:' || p_run_id::text || ':' || v_idem
  );

  insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_item_id, p_run_id, 'status-transitioned', p_actor,
    jsonb_build_object('from', v_prev_status, 'to', p_next_status),
    'status-transitioned:' || p_run_id::text || ':' || v_idem
  );

  if p_next_status = 'ready-for-human' then
    insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_item_id, p_run_id, 'human-handoff', p_actor,
      jsonb_build_object('reason', coalesce(p_handoff_reason, 'unspecified')),
      'human-handoff:' || p_run_id::text || ':' || v_idem
    );
  end if;

  item_id := v_item_id;
  run_id  := p_run_id;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- apply_change_set — Triage Change Set application
-- ═══════════════════════════════════════════════════════════════
--
-- Applies all proposed operations in a Change Set in sequence_index order
-- inside a single transaction. Stop-on-failure: the first failing op marks
-- itself + all downstream ops as `failed`/`skipped`, and the function
-- raises so the whole transaction rolls back EXCEPT the bookkeeping update
-- that flagged the failure.
--
-- For v1 we keep this safer-but-simpler: try every op; if any throws,
-- transactionally roll back and mark the change set as `proposed` (still)
-- with status='failed' on the offending op. UI surfaces the error and a
-- human can edit + retry.
--
-- Operation payload conventions (matched to op types in the schema):
--   create-item                   { content_md, classifications[], expected_paths[],
--                                   expected_artifact_type, git_repository_ref,
--                                   queue_rank, priority_class, placement_reason }
--   add-content-revision          { work_item_id, content_md, reason }
--   set-classifications           { work_item_id, classifications[] }
--   add-relationship              { parent_id, child_id, type, parent_review_requirement }
--   set-parent-review-requirement { relationship_id, value, reason }
--   record-git-branch             { work_item_id, git_branch, base_branch }
--   set-ready-state               { work_item_id, ready: bool }      -- shorthand for transition
--   set-queue-rank                { work_item_id, queue_rank, priority_class, placement_reason }
--   transition-work-item          { work_item_id, to_status, from_status }
--
-- This RPC is called both from major-finalize-triage-session (when path-
-- blocker auto-applies) and from major-apply-change-set (manual human apply).
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
  v_idem_root      text := coalesce(p_idempotency_root, p_change_set_id::text);
  v_new_item_id    bigint;
  v_new_revision   bigint;
  v_existing_max   integer;
begin
  -- Iterate ops in sequence order. Each op is its own conditional branch;
  -- any failure raises and rolls the whole apply back.
  for v_op in
    select id, operation_type, payload, sequence_index
    from major.triage_change_operations
    where change_set_id = p_change_set_id
      and status in ('proposed', 'accepted')
    order by sequence_index asc
    for update
  loop
    v_payload := v_op.payload;

    if v_op.operation_type = 'create-item' then
      insert into major.work_items (
        status, classifications, expected_artifact_type, expected_paths,
        git_repository_ref, base_branch, queue_rank, priority_class, placement_reason
      ) values (
        'ready-for-triage',
        coalesce((v_payload->'classifications')::text[]::text[], '{}'),
        v_payload->>'expected_artifact_type',
        coalesce(array(select jsonb_array_elements_text(v_payload->'expected_paths')), '{}'),
        v_payload->>'git_repository_ref',
        coalesce(v_payload->>'base_branch', 'dev'),
        nullif((v_payload->>'queue_rank'),'')::integer,
        v_payload->>'priority_class',
        v_payload->>'placement_reason'
      )
      returning id into v_new_item_id;

      if v_payload ? 'content_md' then
        insert into major.work_item_content_revisions (
          work_item_id, revision_number, content_md, author_actor, reason
        ) values (
          v_new_item_id, 1, v_payload->>'content_md', p_actor, 'create-item'
        )
        returning id into v_new_revision;

        update major.work_items set current_revision_id = v_new_revision where id = v_new_item_id;
      end if;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        v_new_item_id, 'item-created', p_actor,
        jsonb_build_object('change_set_id', p_change_set_id, 'sequence_index', v_op.sequence_index),
        'item-created:' || v_new_item_id::text || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now(),
          resulting_record_ref = jsonb_build_object('work_item_id', v_new_item_id, 'revision_id', v_new_revision)
      where id = v_op.id;

    elsif v_op.operation_type = 'add-content-revision' then
      select coalesce(max(revision_number), 0) into v_existing_max
      from major.work_item_content_revisions
      where work_item_id = (v_payload->>'work_item_id')::bigint;

      insert into major.work_item_content_revisions (
        work_item_id, revision_number, content_md, author_actor, reason
      ) values (
        (v_payload->>'work_item_id')::bigint,
        v_existing_max + 1,
        v_payload->>'content_md',
        p_actor,
        v_payload->>'reason'
      )
      returning id into v_new_revision;

      update major.work_items
      set current_revision_id = v_new_revision
      where id = (v_payload->>'work_item_id')::bigint;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'work_item_id')::bigint, 'content-revision-added', p_actor,
        jsonb_build_object('revision_id', v_new_revision, 'reason', v_payload->>'reason'),
        'content-revision-added:' || v_new_revision::text || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now(),
          resulting_record_ref = jsonb_build_object('revision_id', v_new_revision)
      where id = v_op.id;

    elsif v_op.operation_type = 'set-classifications' then
      update major.work_items
      set classifications = coalesce(array(select jsonb_array_elements_text(v_payload->'classifications')), '{}')
      where id = (v_payload->>'work_item_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'add-relationship' then
      insert into major.work_item_relationships (
        parent_id, child_id, type, parent_review_requirement
      ) values (
        (v_payload->>'parent_id')::bigint,
        (v_payload->>'child_id')::bigint,
        v_payload->>'type',
        coalesce(v_payload->>'parent_review_requirement', 'required')
      )
      on conflict (parent_id, child_id, type) do nothing;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'child_id')::bigint, 'relationship-added', p_actor,
        v_payload,
        'relationship-added:' || (v_payload->>'parent_id') || ':' || (v_payload->>'child_id') || ':' || v_idem_root
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-parent-review-requirement' then
      update major.work_item_relationships
      set parent_review_requirement = v_payload->>'value',
          excluded_reason = v_payload->>'reason',
          excluded_by_actor = p_actor
      where id = (v_payload->>'relationship_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'record-git-branch' then
      update major.work_items
      set git_branch = v_payload->>'git_branch',
          base_branch = coalesce(v_payload->>'base_branch', base_branch)
      where id = (v_payload->>'work_item_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-ready-state' then
      -- Shorthand: ready=true → ready-for-agent (path-blocker should already
      -- have allowed this set if needed). false → ready-for-triage.
      update major.work_items
      set status = case when (v_payload->>'ready')::boolean then 'ready-for-agent' else 'ready-for-triage' end
      where id = (v_payload->>'work_item_id')::bigint;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'work_item_id')::bigint, 'status-transitioned', p_actor,
        v_payload,
        'status-transitioned-srs:' || (v_payload->>'work_item_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-queue-rank' then
      update major.work_items
      set queue_rank = nullif(v_payload->>'queue_rank','')::integer,
          priority_class = v_payload->>'priority_class',
          placement_reason = v_payload->>'placement_reason'
      where id = (v_payload->>'work_item_id')::bigint;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'work_item_id')::bigint, 'queue-rank-set', p_actor,
        v_payload,
        'queue-rank-set:' || (v_payload->>'work_item_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'transition-work-item' then
      update major.work_items
      set status = v_payload->>'to_status'
      where id = (v_payload->>'work_item_id')::bigint;

      insert into major.events (work_item_id, type, actor, payload, idempotency_key)
      values (
        (v_payload->>'work_item_id')::bigint, 'status-transitioned', p_actor,
        v_payload,
        'status-transitioned-twi:' || (v_payload->>'work_item_id') || ':' || v_idem_root || ':' || v_op.sequence_index
      );

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    else
      raise exception 'unknown operation_type %', v_op.operation_type;
    end if;

    v_count := v_count + 1;
  end loop;

  -- Mark the change set accepted now that every op succeeded.
  update major.triage_change_sets
  set decision = 'accepted', decision_actor = p_actor, decided_at = now()
  where id = p_change_set_id;

  applied_op_count := v_count;
  failed_op_id := null;
  failure_message := null;
  return next;
end;
$$;

-- Convenience: pg_cron will call this. No JWT required (server-side).
create or replace function major.reaper_sweep()
returns table (cancelled_runs integer, items_returned integer)
language plpgsql security definer as $$
declare
  v_run record;
  v_cancelled integer := 0;
  v_returned  integer := 0;
begin
  for v_run in
    select id, work_item_id, runner_id
    from major.runs
    where outcome = 'running' and lease_expires_at < now()
    for update skip locked
  loop
    update major.runs
    set outcome = 'cancelled',
        cancellation_reason = 'lease-expired',
        ended_at = now()
    where id = v_run.id;
    v_cancelled := v_cancelled + 1;

    update major.work_items
    set status = 'ready-for-agent'
    where id = v_run.work_item_id and status = 'agent-running';
    v_returned := v_returned + 1;

    insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.work_item_id, v_run.id, 'run-ended', 'major:reaper',
      jsonb_build_object('outcome', 'cancelled', 'cancellation_reason', 'lease-expired'),
      'run-ended-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into major.events (work_item_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.work_item_id, v_run.id, 'status-transitioned', 'major:reaper',
      jsonb_build_object('from', 'agent-running', 'to', 'ready-for-agent', 'reason', 'lease-expired'),
      'status-transitioned-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    insert into major.telemetry_records (work_item_id, run_id, observation_type, payload)
    values (
      v_run.work_item_id, v_run.id, 'repair-inspection-trigger',
      jsonb_build_object('reason', 'lease-expired', 'runner_id', v_run.runner_id)
    );
  end loop;

  cancelled_runs := v_cancelled;
  items_returned := v_returned;
  return next;
end;
$$;

grant execute on function major.claim_next_item(text, bigint, integer, text, text) to service_role;
grant execute on function major.finalize_run(bigint, text, text, text, text, text, jsonb, jsonb, text) to service_role;
grant execute on function major.apply_change_set(bigint, text, text) to service_role;
grant execute on function major.reaper_sweep() to service_role;
