-- Major v1 — Phase 3 of Ghost in the Shell rename (ADR 004).
--
-- Cyberbrain schema migration: renames the Foundry-derived primitives
-- (`work_items` / `runner_instances` / `runner_id` / `work_item_id`) to
-- the GITS vocabulary (`briefs` / `shells` / `shell_id` / `brief_id`).
-- Phase 0–2 already landed: ADR accepted, documentation rewritten, and
-- code identifiers (db/types.ts, shell/, edge-function wire shapes)
-- already speak the new vocabulary. This file produces the schema that
-- those code identifiers expect.
--
-- Apply via direct psql per `docs/runbook.md §1.2` (the shared
-- _supabase_migrations history with HealthBite blocks `supabase db
-- push`):
--
--   SUPABASE_DB_PASSWORD='...' psql -v ON_ERROR_STOP=1 \
--     -h db.nuihvxluxdpdjgkvtdih.supabase.co -U postgres \
--     -d postgres -f supabase/migrations/20260509000004_gits_renames.sql
--
-- All DDL is wrapped in a single transaction; any failure rolls back
-- the entire rename so the live schema never sits half-renamed.
--
-- Phase 4 will follow up with edge-function directory renames + RPC
-- call-site updates. Until Phase 4 deploys, the existing `major-claim-
-- item` / `major-finalize-run` / `major-apply-change-set` edge functions
-- WILL fail at runtime — they call `claim_next_item` / `finalize_run`
-- with old param names and read `item_id` out of the result. That's
-- expected; Phase 4 ships the matching code change.

set search_path = major, public;

begin;

-- ═══════════════════════════════════════════════════════════════
-- 1. DROP FUNCTIONS — recreated at the bottom with new names + bodies.
-- ═══════════════════════════════════════════════════════════════
-- plpgsql function bodies bind identifier names lazily at execute time,
-- so we *could* leave them in place during the column renames; dropping
-- is cleaner and avoids any chance of a function call between rename
-- steps inside the transaction observing a partially-renamed schema.

drop function if exists major.claim_next_item(text, bigint, integer, text, text);
drop function if exists major.finalize_run(bigint, text, text, text, text, text, jsonb, jsonb, text);
drop function if exists major.apply_change_set(bigint, text, text);
drop function if exists major.reaper_sweep();

-- ═══════════════════════════════════════════════════════════════
-- 2. RENAME TABLES
-- ═══════════════════════════════════════════════════════════════
-- Postgres auto-renames each table's primary-key constraint, identity
-- sequence (`<table>_id_seq`), and any default-named index that embeds
-- the table name following standard naming. Foreign-key constraints
-- that REFERENCE these tables keep their old names — those are renamed
-- explicitly later in section 7.

alter table major.work_items                   rename to briefs;
alter table major.work_item_content_revisions  rename to brief_content_revisions;
alter table major.work_item_relationships      rename to brief_relationships;
alter table major.work_item_artifacts          rename to brief_artifacts;
alter table major.runner_instances             rename to shells;

-- ═══════════════════════════════════════════════════════════════
-- 3. RENAME COLUMNS
-- ═══════════════════════════════════════════════════════════════

alter table major.runs                     rename column work_item_id to brief_id;
alter table major.runs                     rename column runner_id    to shell_id;
alter table major.brief_content_revisions  rename column work_item_id to brief_id;
alter table major.brief_artifacts          rename column work_item_id to brief_id;
alter table major.auto_triage_requests     rename column work_item_id to brief_id;
alter table major.events                   rename column work_item_id to brief_id;
alter table major.telemetry_records        rename column work_item_id to brief_id;

-- ═══════════════════════════════════════════════════════════════
-- 4. UPDATE CHECK CONSTRAINTS WITH ENUMERATED STRING VALUES
-- ═══════════════════════════════════════════════════════════════
-- triage_change_operations.operation_type listed `'create-item'` and
-- `'transition-work-item'`. Phase 2 already rewrote edge-function code
-- to emit `'create-brief'` / `'transition-brief'`, so the constraint
-- must accept the new vocabulary before any new ops land.
--
-- We update existing rows BEFORE swapping the CHECK so the new
-- constraint validates cleanly. The default name PG gives this CHECK
-- is `triage_change_operations_operation_type_check`.

update major.triage_change_operations
set operation_type = 'create-brief'
where operation_type = 'create-item';

update major.triage_change_operations
set operation_type = 'transition-brief'
where operation_type = 'transition-work-item';

alter table major.triage_change_operations
  drop constraint triage_change_operations_operation_type_check;

alter table major.triage_change_operations
  add constraint triage_change_operations_operation_type_check
  check (operation_type in (
    'create-brief',
    'add-content-revision',
    'set-classifications',
    'add-relationship',
    'set-parent-review-requirement',
    'record-git-branch',
    'set-ready-state',
    'set-queue-rank',
    'transition-brief'
  ));

-- ═══════════════════════════════════════════════════════════════
-- 5. UPDATE EXISTING DATA TO NEW VOCABULARY
-- ═══════════════════════════════════════════════════════════════
-- These columns are plain text (no CHECK), but historical rows hold the
-- old-vocabulary strings that new code no longer emits. Rewrite them so
-- queries / dashboards / readers using the new vocabulary find them.

-- events.type — `item-created` was emitted by apply_change_set's
-- create-item branch (now create-brief). Phase 2 db/types.ts switched
-- KnownEventType to `brief-created`.
update major.events
set type = 'brief-created'
where type = 'item-created';

-- events.actor — `runner:<id>` now reads `shell:<id>`. The id portion
-- stays the same (current Shells will heartbeat in as `shell-A` etc
-- after Phase 5 restart; old rows attribute to the old container ids).
update major.events
set actor = 'shell:' || substr(actor, length('runner:') + 1)
where actor like 'runner:%';

-- artifact_type_contracts authority arrays — `'runner'` element
-- becomes `'shell'`. claim_authority / produce_authority /
-- review_authority all use it; acceptance_authority does not (humans
-- only).
update major.artifact_type_contracts
set claim_authority   = array_replace(claim_authority,   'runner', 'shell'),
    produce_authority = array_replace(produce_authority, 'runner', 'shell'),
    review_authority  = array_replace(review_authority,  'runner', 'shell');

-- ═══════════════════════════════════════════════════════════════
-- 6. RENAME INDEXES
-- ═══════════════════════════════════════════════════════════════
-- Indexes whose names embed the old vocabulary. Some indexes auto-
-- renamed when their table renamed (PG follows `<table>_pkey` etc),
-- but the bespoke `idx_*` names did not.
-- `idx_runs_single_active` and `idx_runs_lease` keep their names — the
-- concept is unchanged and the column rename inside them happened
-- transparently when we renamed `runs.work_item_id`.

alter index major.idx_work_items_status_queue       rename to idx_briefs_status_queue;
alter index major.idx_work_items_repo               rename to idx_briefs_repo;
alter index major.idx_work_items_branch             rename to idx_briefs_branch;
alter index major.idx_revisions_work_item           rename to idx_revisions_brief;
alter index major.idx_runner_instances_heartbeat    rename to idx_shells_heartbeat;
alter index major.idx_runs_runner                   rename to idx_runs_shell;
alter index major.idx_artifacts_work_item           rename to idx_artifacts_brief;
alter index major.idx_events_work_item              rename to idx_events_brief;
alter index major.idx_telemetry_work_item           rename to idx_telemetry_brief;

-- ═══════════════════════════════════════════════════════════════
-- 7. RENAME CONSTRAINTS (FOREIGN KEYS + EXPLICITLY-NAMED CONSTRAINTS)
-- ═══════════════════════════════════════════════════════════════
-- PG default FK names embed the table+column at creation time and do
-- not auto-update when those renamed. Renaming for hygiene so future
-- DDL diagnostics are readable.

-- Explicit named constraint from initial_schema.sql line 70.
alter table major.briefs
  rename constraint fk_work_items_current_revision to fk_briefs_current_revision;

-- runs FKs (only the two whose embedded column name actually
-- changed need renaming; runs_started_against_revision_id_fkey,
-- runs_inspected_run_id_fkey are unchanged.)
alter table major.runs
  rename constraint runs_work_item_id_fkey to runs_brief_id_fkey;
alter table major.runs
  rename constraint runs_runner_id_fkey to runs_shell_id_fkey;

-- brief_content_revisions FK
alter table major.brief_content_revisions
  rename constraint work_item_content_revisions_work_item_id_fkey
  to brief_content_revisions_brief_id_fkey;

-- brief_relationships FKs (parent_id and child_id reference briefs)
alter table major.brief_relationships
  rename constraint work_item_relationships_parent_id_fkey
  to brief_relationships_parent_id_fkey;
alter table major.brief_relationships
  rename constraint work_item_relationships_child_id_fkey
  to brief_relationships_child_id_fkey;
alter table major.brief_relationships
  rename constraint work_item_relationships_excluded_revision_id_fkey
  to brief_relationships_excluded_revision_id_fkey;

-- brief_artifacts FKs
alter table major.brief_artifacts
  rename constraint work_item_artifacts_work_item_id_fkey
  to brief_artifacts_brief_id_fkey;
alter table major.brief_artifacts
  rename constraint work_item_artifacts_run_id_fkey
  to brief_artifacts_run_id_fkey;

-- auto_triage_requests FKs
alter table major.auto_triage_requests
  rename constraint auto_triage_requests_work_item_id_fkey
  to auto_triage_requests_brief_id_fkey;

-- events FKs
alter table major.events
  rename constraint events_work_item_id_fkey
  to events_brief_id_fkey;

-- telemetry_records FKs
alter table major.telemetry_records
  rename constraint telemetry_records_work_item_id_fkey
  to telemetry_records_brief_id_fkey;

-- ═══════════════════════════════════════════════════════════════
-- 8. RECREATE FUNCTIONS WITH NEW NAMES + REWRITTEN BODIES
-- ═══════════════════════════════════════════════════════════════
-- All four RPC bodies referenced renamed tables / columns and so were
-- dropped in section 1. Recreated below with identifiers updated to
-- the new vocabulary. Logic is unchanged — only identifiers swap.
-- Function-grade renames done here:
--   claim_next_item   -> claim_next_brief
--   p_runner_id       -> p_shell_id          (param)
--   p_specific_item_id-> p_specific_brief_id (param)
--   item_id           -> brief_id            (out column)
-- Param-name change is necessary because the function name itself
-- changed: any caller has to update the rpc(...) name regardless, so
-- preserving param names buys nothing while leaving stale vocabulary.

-- ─── claim_next_brief (Run Start Transaction) ───
create or replace function major.claim_next_brief(
  p_shell_id           text,
  p_specific_brief_id  bigint default null,
  p_lease_minutes      integer default 5,
  p_purpose            text default 'execute',
  p_idempotency_key    text default null
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
  -- Select target brief id with row lock; SKIP LOCKED loses to a
  -- concurrent claimer cleanly (returns no row, caller polls again).
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
    started_against_revision_id, claimed_at, lease_expires_at, heartbeat_at
  ) values (
    v_brief_id, p_purpose, 'running', p_shell_id,
    v_revision, now(), v_lease, now()
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

-- ─── finalize_run (Run Finalization Transaction) ───
-- Function name unchanged ('finalize_run' is artifact-agnostic); body
-- updated to reference `briefs` / `brief_id` / `brief_artifacts`. Out
-- column `item_id` renamed to `brief_id` to match the rest of the API.
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
returns table (brief_id bigint, run_id bigint) language plpgsql security definer as $$
#variable_conflict use_column
declare
  v_brief_id   bigint;
  v_prev_status text;
  v_idem       text := coalesce(p_idempotency_key, gen_random_uuid()::text);
  vr           jsonb;
  ar           jsonb;
begin
  -- Lock the run row + parent brief. Qualify `runs.brief_id` because
  -- the OUT parameter shares its name; #variable_conflict use_column
  -- sets the default but explicit qualification is unambiguous either
  -- way.
  select runs.brief_id into v_brief_id from major.runs where id = p_run_id for update;
  if v_brief_id is null then
    raise exception 'run % not found', p_run_id;
  end if;

  select status into v_prev_status from major.briefs where id = v_brief_id for update;

  update major.runs
  set outcome = p_outcome,
      cancellation_reason = p_cancellation_reason,
      ended_at = now()
  where id = p_run_id;

  -- Insert verification_results. Each entry: { check_name, outcome,
  -- required, requiredness_source, payload }
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

  -- Insert brief_artifacts.
  for ar in select * from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb))
  loop
    insert into major.brief_artifacts (
      brief_id, run_id, artifact_type, external_ref, payload
    ) values (
      v_brief_id,
      p_run_id,
      ar->>'artifact_type',
      ar->>'external_ref',
      coalesce(ar->'payload', '{}'::jsonb)
    );
  end loop;

  update major.briefs set status = p_next_status where id = v_brief_id;

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'run-ended', p_actor,
    jsonb_build_object('outcome', p_outcome, 'cancellation_reason', p_cancellation_reason),
    'run-ended:' || p_run_id::text || ':' || v_idem
  );

  insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
  values (
    v_brief_id, p_run_id, 'status-transitioned', p_actor,
    jsonb_build_object('from', v_prev_status, 'to', p_next_status),
    'status-transitioned:' || p_run_id::text || ':' || v_idem
  );

  if p_next_status = 'ready-for-human' then
    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_brief_id, p_run_id, 'human-handoff', p_actor,
      jsonb_build_object('reason', coalesce(p_handoff_reason, 'unspecified')),
      'human-handoff:' || p_run_id::text || ':' || v_idem
    );
  end if;

  brief_id := v_brief_id;
  run_id   := p_run_id;
  return next;
end;
$$;

-- ─── apply_change_set (Triage Change Set application) ───
-- Body updated to reference briefs / brief_content_revisions /
-- brief_relationships and to switch the create-item / transition-
-- work-item branches to create-brief / transition-brief, plus emit
-- `brief-created` events. Logic is structurally unchanged.
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
  v_new_brief_id   bigint;
  v_new_revision   bigint;
  v_existing_max   integer;
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

    if v_op.operation_type = 'create-brief' then
      insert into major.briefs (
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
          excluded_reason = v_payload->>'reason',
          excluded_by_actor = p_actor
      where id = (v_payload->>'relationship_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'record-git-branch' then
      update major.briefs
      set git_branch = v_payload->>'git_branch',
          base_branch = coalesce(v_payload->>'base_branch', base_branch)
      where id = (v_payload->>'brief_id')::bigint;

      update major.triage_change_operations
      set status = 'applied', applied_actor = p_actor, applied_at = now()
      where id = v_op.id;

    elsif v_op.operation_type = 'set-ready-state' then
      -- Shorthand: ready=true → ready-for-agent, false → ready-for-triage.
      update major.briefs
      set status = case when (v_payload->>'ready')::boolean then 'ready-for-agent' else 'ready-for-triage' end
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
      set queue_rank = nullif(v_payload->>'queue_rank','')::integer,
          priority_class = v_payload->>'priority_class',
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
  failed_op_id := null;
  failure_message := null;
  return next;
end;
$$;

-- ─── reaper_sweep (lease-expired Run cancellation) ───
create or replace function major.reaper_sweep()
returns table (cancelled_runs integer, briefs_returned integer)
language plpgsql security definer as $$
declare
  v_run record;
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
    set outcome = 'cancelled',
        cancellation_reason = 'lease-expired',
        ended_at = now()
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

  cancelled_runs   := v_cancelled;
  briefs_returned  := v_returned;
  return next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════
-- 9. RECREATE TRIGGER ON RENAMED `briefs` TABLE
-- ═══════════════════════════════════════════════════════════════
-- The `set_updated_at` trigger function still exists (we didn't drop
-- it). The trigger object `trg_work_items_updated_at` survives the
-- table rename in PG (it's attached to the renamed table object), but
-- its NAME still embeds the old vocabulary. Rename for hygiene.

alter trigger trg_work_items_updated_at on major.briefs
  rename to trg_briefs_updated_at;

-- ═══════════════════════════════════════════════════════════════
-- 10. GRANTS ON RECREATED FUNCTIONS
-- ═══════════════════════════════════════════════════════════════
-- DROP FUNCTION nuked the per-function execute grants we set in the
-- v1 RPC migration. The schema-grants migration's `default privileges
-- … grant execute on functions to service_role` covers FUTURE
-- functions; existing recreated functions still need explicit grants.
-- (default privileges only fires at CREATE time when no other grant
-- exists, which DROP+CREATE does satisfy — but being explicit is
-- cheaper than debugging a 42501 in prod.)

grant execute on function major.claim_next_brief(text, bigint, integer, text, text) to service_role;
grant execute on function major.finalize_run(bigint, text, text, text, text, text, jsonb, jsonb, text) to service_role;
grant execute on function major.apply_change_set(bigint, text, text) to service_role;
grant execute on function major.reaper_sweep() to service_role;

commit;
