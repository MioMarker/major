-- 20260512000000_stream_b_schema.sql
-- Stream B schema prerequisites: Brief 62, Plan 001 §3 Stream B.
--
-- Two additive, IF NOT EXISTS changes required by the RPC atomicity fixes
-- that follow in 20260512000001_rpc_v2_stream_b.sql:
--
-- 1. Unique partial index on major.brief_artifacts for ON CONFLICT dedup in
--    finalize_run (finding F-13). Covers only rows where external_ref IS NOT
--    NULL — those are the PR-URL artifact rows that would duplicate on retry.
--    Rows with null external_ref are rare and still insertable multiple times
--    (acceptable for v1; see Plan 001 §4 Risk R-4).
--
-- 2. claim_idempotency_key column on major.runs with a partial unique index
--    on (shell_id, claim_idempotency_key). When a Shell retries a failed
--    claim_next_brief call with the same key, the RPC returns the existing
--    Run instead of creating a duplicate (finding F-06). NULL keys excluded
--    from the unique index so legacy Run rows created before this column
--    never conflict.

set search_path = major, public;

begin;

-- ─── 1. brief_artifacts dedup index (F-13) ───────────────────────────────────

create unique index if not exists idx_brief_artifacts_dedup
  on major.brief_artifacts (run_id, artifact_type, external_ref)
  where external_ref is not null;

-- ─── 2. claim_idempotency_key on runs (F-06) ─────────────────────────────────

alter table major.runs
  add column if not exists claim_idempotency_key text;

-- A Shell may not create two active Run claims with the same key.
-- Partial index: NULL keys are legacy rows and must not participate.
create unique index if not exists idx_runs_claim_idempotency
  on major.runs (shell_id, claim_idempotency_key)
  where claim_idempotency_key is not null;

commit;
