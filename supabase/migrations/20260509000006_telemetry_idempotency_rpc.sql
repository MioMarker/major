-- 20260509000006_telemetry_idempotency_rpc.sql
-- Implements docs/adr/005-tachikoma-command-observability.md Phase 1
--
-- Adds idempotency_key to major.telemetry_records (enables dedup on the
-- Bash-hook write path and any other telemetry writer), then creates the
-- record_telemetry_observation RPC that atomically increments
-- runs.tachikoma_event_sequence and inserts the Telemetry Record in a
-- single Postgres transaction.

begin;

-- Add idempotency_key; nullable so existing rows aren't broken. New writes
-- from major-record-telemetry always supply the key.
alter table major.telemetry_records
  add column if not exists idempotency_key text;

create unique index if not exists idx_telemetry_idempotency_key
  on major.telemetry_records (idempotency_key)
  where idempotency_key is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- record_telemetry_observation
--
-- Atomically:
--   1. Check for an existing record with the same idempotency_key → no-op.
--   2. Increment runs.tachikoma_event_sequence and capture brief_id.
--   3. Insert the sanitized Telemetry Record.
--
-- Runs as SECURITY DEFINER so edge functions can call it via service-role RPC
-- without requiring direct table-write grants (those already exist, but DEFINER
-- makes the auth story explicit).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function major.record_telemetry_observation(
  p_run_id           bigint,
  p_observation_type text,
  p_payload          jsonb,
  p_idempotency_key  text
)
returns setof major.telemetry_records
language plpgsql
security definer
as $$
declare
  v_seq      integer;
  v_brief_id bigint;
  v_existing major.telemetry_records;
begin
  -- Idempotency check: return the existing row without touching the sequence.
  select * into v_existing
  from major.telemetry_records
  where idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return next v_existing;
    return;
  end if;

  -- Atomic sequence increment; also captures brief_id so we can FK it on insert.
  update major.runs
    set tachikoma_event_sequence = tachikoma_event_sequence + 1
    where id = p_run_id
    returning tachikoma_event_sequence, brief_id into v_seq, v_brief_id;

  if not found then
    raise exception 'Run % not found', p_run_id;
  end if;

  return query
    insert into major.telemetry_records (
      brief_id, run_id, observation_type, payload, idempotency_key
    ) values (
      v_brief_id, p_run_id, p_observation_type, p_payload, p_idempotency_key
    )
    returning *;
end;
$$;

commit;
