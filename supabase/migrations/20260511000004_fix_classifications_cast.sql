-- 20260511000004_fix_classifications_cast.sql
--
-- Fixes the `create-brief` branch in apply_change_set: the classifications
-- column was cast via (jsonb)::text[]::text[] which Postgres rejects with
-- "cannot cast type jsonb to text[]". Use jsonb_array_elements_text instead,
-- consistent with the existing expected_paths handling in the same function.

set search_path = major, public;

begin;

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

    -- Resolve the __auto__ placeholder before each op.  If the payload's
    -- brief_id is "__auto__", substitute the id of the Brief created earlier
    -- in this same change set by a create-brief op.
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
        coalesce(array(select jsonb_array_elements_text(v_payload->'classifications')), '{}'),
        v_payload->>'expected_artifact_type',
        coalesce(array(select jsonb_array_elements_text(v_payload->'expected_paths')), '{}'),
        v_payload->>'git_repository_ref',
        coalesce(v_payload->>'base_branch', 'dev'),
        nullif((v_payload->>'queue_rank'),'')::integer,
        v_payload->>'priority_class',
        v_payload->>'placement_reason',
        nullif((v_payload->>'source_session_id'),'')::bigint,
        v_payload->>'source_issue_repo',
        nullif((v_payload->>'source_issue_number'),'')::integer
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

grant execute on function major.apply_change_set(bigint, text, text) to service_role;
grant execute on function major.apply_change_set(bigint, text, text) to authenticated;

commit;
