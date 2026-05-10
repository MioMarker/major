-- 20260509000005_tachikoma_stream_json_telemetry.sql
-- Implements docs/adr/006-tachikoma-stream-json-telemetry.md
-- Adds runs-table columns for stream-json summary metrics + sequence counter
-- for per-event Telemetry idempotency.

begin;

alter table major.runs
  add column if not exists num_turns                 integer,
  add column if not exists duration_ms               integer,
  add column if not exists final_text                text,
  add column if not exists input_tokens              integer,
  add column if not exists output_tokens             integer,
  add column if not exists cache_read_tokens         integer,
  add column if not exists cache_write_tokens        integer,
  add column if not exists tachikoma_event_sequence  integer not null default 0;

commit;
