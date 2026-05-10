-- 20260509000007_finalize_run_summary_metrics.sql
-- Implements docs/adr/006-tachikoma-stream-json-telemetry.md (Slice 4)
--
-- Replaces finalize_run with an extended version that accepts the seven
-- stream-json summary metric columns and folds them into the existing
-- UPDATE major.runs in step 1 of the Run Finalization Transaction.

begin;

-- Drop the 9-param overload so we can install the 16-param replacement.
drop function if exists major.finalize_run(
  bigint, text, text, text, text, text, jsonb, jsonb, text
);

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
  -- Stream-json completion summary metrics (ADR 006 Slice 4). All nullable;
  -- null when the Run did not produce a completion event (e.g. crash, timeout).
  p_num_turns            integer default null,
  p_duration_ms          integer default null,
  p_final_text           text    default null,
  p_input_tokens         integer default null,
  p_output_tokens        integer default null,
  p_cache_read_tokens    integer default null,
  p_cache_write_tokens   integer default null
)
returns table (brief_id bigint, run_id bigint)
language plpgsql security definer as $$
#variable_conflict use_column
declare
  v_brief_id    bigint;
  v_prev_status text;
  v_idem        text := coalesce(p_idempotency_key, gen_random_uuid()::text);
  vr            jsonb;
  ar            jsonb;
begin
  -- Lock the run row + parent brief.
  select runs.brief_id into v_brief_id
  from major.runs
  where id = p_run_id
  for update;

  if v_brief_id is null then
    raise exception 'run % not found', p_run_id;
  end if;

  select status into v_prev_status
  from major.briefs
  where id = v_brief_id
  for update;

  -- Step 1: finalize the run row and hoist summary metrics in a single UPDATE.
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

  -- Step 3: insert brief_artifacts.
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
    );
  end loop;

  -- Step 4: transition the brief.
  update major.briefs
  set status = p_next_status
  where id = v_brief_id;

  -- Step 5: emit lifecycle events.
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

grant execute on function major.finalize_run(
  bigint, text, text, text, text, text, jsonb, jsonb, text,
  integer, integer, text, integer, integer, integer, integer
) to service_role;

commit;
