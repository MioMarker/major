-- 20260525000003_reaper_sweep_enforce_retry_budget.sql
-- Implements docs/adr/014-run-retry-budget.md (server-side enforcement) and
-- docs/runbook.md §2.9 ("if attempt_number < max_attempts the Brief is re-armed
-- to ready-for-agent; if attempt_number >= max_attempts it is routed to
-- ready-for-human with retry_budget_exhausted: true"). Mirrors the cap added to
-- finalize_run in 20260525000002_finalize_run_enforce_retry_budget.sql.
--
-- INCIDENT (#169): the retry storm that 20260525000002 closed in finalize_run had
-- a SECOND, identical bypass that was NOT fixed: reaper_sweep. When a Shell's lease
-- lapses, the live reaper_sweep (20260512000001_rpc_v2_stream_b) cancels the Run and
-- ALWAYS re-arms the Brief straight back to 'ready-for-agent' with no budget check
-- (it never reads runs.attempt_number / briefs.max_attempts). A Brief whose Shell
-- keeps dying therefore loops unbounded — the same unbounded retry shape ADR 014's
-- budget exists to prevent. (Not firing on dev today: the reaper is not cron-
-- scheduled. This caps it BEFORE the reaper is enabled.)
--
-- ADR 014 sketched the auto-retry decision living in shell/main.ts. As with
-- finalize_run, the runbook §2.9 contract + the incident make the cap a Cyberbrain
-- invariant (Hard Rule #1 — the Cyberbrain is authoritative): a lease-expired Run
-- whose Brief has exhausted its budget MUST park at ready-for-human, not re-arm. The
-- reaper is a pure Cyberbrain actor (no Shell-side intent to honor here), so this
-- migration applies the cap unconditionally on the reaper's re-arm path — the exact
-- mirror of the finalize_run failure-branch cap.
--
-- This migration CREATE OR REPLACEs reaper_sweep with ONLY the retry-budget cap
-- added. Signature is unchanged from 20260512000001 (no params), so no drop is
-- needed and the existing caller (the major-reaper edge function / pg_cron) is
-- unaffected. Every other duty of reaper_sweep is preserved verbatim: lease-expiry
-- detection (outcome='running' AND lease_expires_at < now(), FOR UPDATE SKIP
-- LOCKED), Run cancellation (outcome='cancelled', cancellation_reason='lease-
-- expired'), the status='agent-running' guard on the Brief update, the run-ended
-- Event and its idempotency key, the repair-inspection-trigger telemetry record,
-- and the cancelled/returned counters.
--
-- The cap (mirror of 20260525000002):
--   For each lease-expired Run the reaper cancels, the Brief is re-armed to
--   'ready-for-agent' ONLY while the cancelled Run's attempt_number <
--   briefs.max_attempts. At or above the cap, the effective next status is
--   'ready-for-human' and a human-handoff Event carries retry_budget_exhausted:
--   true plus attempt_number / max_attempts (identical payload shape to the
--   finalize_run human-handoff Event). The status-transitioned Event's 'to' and
--   'reason' reflect the effective status so the audit trail is accurate.
--
-- The columns this reads already exist (20260510000001_run_retry_budget.sql):
--   * major.briefs.max_attempts   integer not null default 3
--   * major.runs.attempt_number   integer not null default 1
-- Re-asserted with `add column if not exists` below for idempotency / defense-in-
-- depth; the statements are no-ops on the live DB where they exist.
--
-- Scope: reaper_sweep only. finalize_run (capped in 20260525000002), claim_next_brief,
-- and apply_change_set are untouched.
--
-- Depends on:
--   * 20260510000001_run_retry_budget.sql   (max_attempts, attempt_number columns)
--   * 20260512000001_rpc_v2_stream_b.sql    (the reaper_sweep body this supersedes)

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
-- reaper_sweep — lease-expired Run cancellation (v2)
-- ═══════════════════════════════════════════════════════════════
--
-- Identical to the v1 body (20260512000001) except for the ADR 014 / runbook §2.9
-- retry-budget cap on the re-arm path. Signature unchanged → CREATE OR REPLACE (no
-- drop). The cursor now also selects runs.attempt_number; the per-Brief max_attempts
-- is read under a row lock; an effective next status (v_effective_status) replaces
-- the hard-coded 'ready-for-agent' so an above-budget Brief routes to
-- 'ready-for-human' instead of looping. All other behavior is verbatim.

create or replace function major.reaper_sweep()
returns table (cancelled_runs integer, briefs_returned integer)
language plpgsql security definer as $$
declare
  v_run              record;
  v_cancelled        integer := 0;
  v_returned         integer := 0;
  -- ADR 014 retry-budget enforcement state (mirror of finalize_run, 20260525000002).
  v_max_attempts     integer;
  v_budget_exhausted boolean;
  v_effective_status text;
begin
  for v_run in
    -- Lease-expiry detection unchanged. attempt_number added to the projection so
    -- the budget cap can read it without a second query (mirrors finalize_run,
    -- which captures attempt_number alongside the run row).
    select id, brief_id, shell_id, attempt_number
    from major.runs
    where outcome = 'running' and lease_expires_at < now()
    for update skip locked
  loop
    -- Run cancellation: verbatim from v1 (outcome, reason, ended_at).
    update major.runs
    set outcome             = 'cancelled',
        cancellation_reason = 'lease-expired',
        ended_at            = now()
    where id = v_run.id;
    v_cancelled := v_cancelled + 1;

    -- ── ADR 014 / runbook §2.9: retry-budget cap on the reaper's re-arm path ────
    --
    -- v1 always re-armed the Brief to 'ready-for-agent'. That reproduced ADR 012's
    -- unbounded-retry hazard for lease-lapse loops (#169). Mirror the finalize_run
    -- cap (20260525000002): re-arm ONLY while the cancelled Run's attempt_number is
    -- below the Brief's max_attempts; at or above the cap, route to 'ready-for-human'
    -- so the auto-retry loop terminates and a human becomes the backstop. Read
    -- max_attempts under the same FOR UPDATE lock used for the status update below.
    select max_attempts
    into v_max_attempts
    from major.briefs
    where id = v_run.brief_id
    for update;

    v_budget_exhausted := (v_run.attempt_number >= coalesce(v_max_attempts, 3));
    v_effective_status := case when v_budget_exhausted
                            then 'ready-for-human'
                            else 'ready-for-agent' end;
    -- ────────────────────────────────────────────────────────────────────────────

    -- Brief transition to the EFFECTIVE next status (post-cap). The
    -- status='agent-running' guard is preserved verbatim: the reaper only moves a
    -- Brief it still owns in agent-running, never one a concurrent path advanced.
    update major.briefs
    set status = v_effective_status
    where id = v_run.brief_id and status = 'agent-running';
    v_returned := v_returned + 1;

    -- run-ended Event: verbatim from v1 (idempotency key unchanged). The reaper has
    -- no caller-supplied idempotency token; the run_id is unique per cancellation.
    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.brief_id, v_run.id, 'run-ended', 'major:reaper',
      jsonb_build_object('outcome', 'cancelled', 'cancellation_reason', 'lease-expired'),
      'run-ended-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    -- status-transitioned Event: same shape and idempotency key as v1, but 'to' /
    -- 'reason' now reflect the EFFECTIVE status so the audit trail records whether
    -- the Brief was re-armed or parked for a human.
    insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
    values (
      v_run.brief_id, v_run.id, 'status-transitioned', 'major:reaper',
      jsonb_build_object(
        'from', 'agent-running',
        'to', v_effective_status,
        'reason', case when v_budget_exhausted
                    then 'lease-expired; retry budget exhausted'
                    else 'lease-expired' end
      ),
      'status-transitioned-reaper:' || v_run.id::text
    )
    on conflict (idempotency_key) do nothing;

    -- Human-handoff Event (NEW): fires only when the cap forced 'ready-for-human'.
    -- Payload mirrors the finalize_run human-handoff Event (20260525000002):
    -- retry_budget_exhausted: true plus attempt_number / max_attempts so operators
    -- can filter for budget-exhausted dispositions and see how the budget was spent.
    -- Idempotency key follows the reaper's run_id-scoped style (no caller token).
    if v_effective_status = 'ready-for-human' then
      insert into major.events (brief_id, run_id, type, actor, payload, idempotency_key)
      values (
        v_run.brief_id, v_run.id, 'human-handoff', 'major:reaper',
        jsonb_build_object(
          'reason', 'retry budget exhausted: attempt ' || v_run.attempt_number::text
            || ' of max ' || coalesce(v_max_attempts, 3)::text || ' (lease-expired)',
          'retry_budget_exhausted', true,
          'attempt_number', v_run.attempt_number,
          'max_attempts', coalesce(v_max_attempts, 3)
        ),
        'human-handoff-reaper:' || v_run.id::text
      )
      on conflict (idempotency_key) do nothing;
    end if;

    -- repair-inspection-trigger telemetry: verbatim from v1.
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

-- Re-state the grant (signature unchanged: no params). Idempotent.
grant execute on function major.reaper_sweep() to service_role;

commit;
