# 024. Closed-Triage-Session retention purge: pg_cron janitor for terminal Triage Sessions

## Status

`Accepted`

Date: 2026-05-31

## Context

`closed` is a terminal Triage Session Status. Once a session is finalized — either by promoting its Change Set into Briefs or by the operator manually closing it — it never transitions again, but its row plus every cascade-linked Triage Change Set, Operation, and message in `transcript` lives in the Cyberbrain forever. The same operability pressure that motivated ADR 023 (the Briefs View filling with terminal `done` work) now applies to the Triage Sessions list: the operator is looking at weeks of `closed` sessions from auto-triage runs and inbound webhooks, and the only way to clean them up is per-row trash icons.

ADR 023 reversed the v1 "no janitor job" cut **narrowly**, for `done` Briefs only. This ADR proposes the parallel reversal for `closed` Triage Sessions, using the same pure-SQL pg_cron mechanism, the same per-sweep Telemetry Record pattern, and a shared (or near-shared) retention window.

The companion UI feature — multi-select on the Triage Sessions list — has already shipped in #183, which mirrored #181's Briefs multi-select pattern. That unblocks manual backlog cleanup today; this ADR is about whether (and how) closed sessions also age out automatically.

### What "X days old" anchors on

`major.triage_sessions` has `created_at` and `updated_at` but no `closed_at`, and there is **no `status-transitioned` Event convention for Triage Sessions** the way there is for Briefs. The only candidates:

1. **`updated_at`** (chosen). Triage Sessions are not routinely touched after closure. Closure happens via `major-finalize-triage-session` (or a manual edit), which bumps `updated_at`; after that, nothing in the current code path mutates a closed session. `updated_at` therefore approximates "closed-at" within seconds, with no drift risk that the Brief equivalent has from post-merge webhook churn.
2. **A new `closed_at timestamptz` column** populated on the open→closed transition. Precise, but requires schema migration + backfill + finalize-function changes for a problem `updated_at` already solves. Worth adding only if a future code path starts mutating closed sessions and breaks the anchor.
3. **A `status-transitioned` Event for Triage Sessions.** Triage Sessions don't write to `major.events` today (Events are scoped to Briefs). Building an Event stream for Triage Sessions just to anchor a retention sweep is over-engineered for v1.

We anchor on (1) and revisit if any future code path starts touching closed sessions after closure.

### Does this violate "agents propose, humans apply"?

Same argument as ADR 023 § "Does a background delete violate ...". The purge is a deterministic retention sweep, not a reasoning step or a lifecycle transition — `closed` is already terminal; the row is removed, not moved. It joins the Reaper and the Brief purge as a third operational background sweep.

Triage Session acceptance is implicit (no human-only boundary like Brief `done`): the operator either runs the auto-triage loop or manually finalizes. The purge only touches sessions that already reached `closed`; it does not advance state.

### What about child Briefs?

`major.briefs.source_session_id` references `triage_sessions(id)`. The existing single-delete endpoint (`major-delete-triage-session`) handles this by **nullifying** the FK on the Brief — child Briefs survive as independent rows. The purge MUST do the same; cascade-deleting child Briefs would destroy live work that happens to have been born from a now-purged session.

Implementation: the purge function nullifies `briefs.source_session_id` for the to-be-deleted sessions, then deletes the dependent `triage_change_sets` rows, then deletes the sessions — all inside one transaction.

`triage_change_sets.triage_session_id` is declared `references major.triage_sessions(id)` **without** `on delete cascade` (`20260509000000_initial_schema.sql:207`); the single-delete endpoint (`major-delete-triage-session`) accordingly deletes change sets explicitly before deleting the session. The purge mirrors that order. (Operations *do* cascade from change sets — `triage_change_operations.change_set_id` has `on delete cascade` at line 228 — so we don't touch them directly.)

### What about `open` sessions stuck in limbo?

Out of scope. `open` is not terminal — an open session could legitimately be a long-lived conversation the operator hasn't returned to. A separate "stale-open" auto-close policy is its own decision (with its own retention window and operator-visible behavior change) and is **not** part of this ADR. The purge here touches only `closed` sessions.

### Retention window

ADR 023 picked 3 days for `done` Briefs. The audit-trail and volume arguments cut both ways for Triage Sessions, but operability dominates in practice: the Triage list fills with `closed` sessions within hours of an auto-triage burst or a webhook backlog, and the operator's daily pain is visual clutter on the Triage page, not lost provenance from a session deleted a week ago. Briefs born from a session that age past 2 days survive (their `source_session_id` is nullified, not the Brief itself), so the only thing the operator loses is the transcript of a *closed* conversation — an audit artifact, not live work.

Pick **2 days** as the default. Aggressive on purpose: shorter than ADR 023's 3-day `done`-Brief window because:

- Triage Sessions reach `closed` orders of magnitude faster than Briefs reach `done` — they accumulate quicker per unit of operator activity, and the list-cleanup pressure is correspondingly higher.
- The audit trail concern is bounded: the source GitHub issue (when there was one) and the resulting Brief both survive the purge and carry their own history. A closed Triage Session that has already produced its Brief has done its job.
- The grace period still covers a normal weekend — a closed session on Friday morning is gone Sunday morning, not in the middle of an active investigation.

As with ADR 023, the retention is the function's default argument, not a UI setting — supersede via a new migration if it needs tuning.

### How to wire the cron

Same as ADR 023 § "How to wire the cron": pure-SQL pg_cron job, function + schedule both registered in the migration, no edge function, no `net.http_post`, no service-role key in cron SQL.

## Decision

**Add a pure-SQL pg_cron janitor that permanently deletes `closed` Triage Sessions once they have been `closed` for ≥ 2 days.**

- New migration `20260531000000_purge_closed_triage_sessions_cron.sql`:
  - `major.purge_closed_triage_sessions(retention_days int default 2) returns integer`, `SECURITY DEFINER`, `search_path = ''`. Selects `id` from `major.triage_sessions` where `status = 'closed'` and `updated_at < now() - make_interval(days => retention_days)`. In one transaction:
    1. `UPDATE major.briefs SET source_session_id = NULL WHERE source_session_id = ANY($ids)` — preserve child Briefs.
    2. `DELETE FROM major.triage_change_sets WHERE triage_session_id = ANY($ids)` — change sets do not cascade from `triage_sessions`; their Operations *do* cascade from change sets via the line-228 FK.
    3. `DELETE FROM major.triage_sessions WHERE id = ANY($ids)`.
    4. Writes one `triage-sessions-purged` Telemetry Record carrying the deleted count and retention window.
  - Returns the count.
  - `cron.schedule('major-purge-closed-triage-sessions', '23 9 * * *', $$ select major.purge_closed_triage_sessions(2); $$)`, registered idempotently (unschedule-if-exists first). Daily cadence at 09:23 UTC — six minutes after the Brief purge (09:17 UTC) so they don't share a transaction window.

- Scope is **`closed` only**. `open` sessions are never touched. Broadening to a stale-open policy is a future ADR.

- Companion UI (multi-select) already shipped in #183.

## Consequences

**Positive:**
- Closed Triage Sessions age out automatically; the Triage Sessions list stays focused on active work.
- The whole job (function + schedule) is captured in a migration — reproducible on a fresh project, no dashboard step.
- Child Briefs are preserved, matching the single-delete endpoint's behavior.
- Each sweep is observable via `major.telemetry_records` (`observation_type = 'triage-sessions-purged'`) and pg_cron's `cron.job_run_details`.

**Negative:**
- Permanent, irreversible deletion. A closed session purged after 2 days takes its transcript and any auto-triage classification payload with it. Briefs that survive lose their `source_session_id` pointer.
- 2 days is short enough that an operator who closes a session on Friday then needs the transcript on Monday morning will find it gone. Mitigation: open it back up before closing if the conversation still has value, or save anything from the transcript that matters into the Brief Content (a Content Revision) before closing.
- The `updated_at` anchor assumes nothing touches closed sessions post-closure. If a future code path violates that (e.g., a retroactive transcript edit), purge timing drifts; mitigate by adding a `closed_at` column at that point.
- pg_cron jobs are global to the shared dev project (also HealthBite's). The job name is namespaced `major-purge-closed-triage-sessions`.

**Follow-on work:**
- `db/types.ts`: add `'triage-sessions-purged'` to `KnownTelemetryObservation`.
- `docs/runbook.md`: add a purge-job operations subsection alongside the Brief purge entry (verify, change retention, unschedule).
- `docs/failure-modes.md`: note the second purge job under scheduled-job behavior.
- Revisit: promote retention to a configurable setting, add a stale-open auto-close policy, or add an atomic bulk-delete endpoint — only if usage demands it.

## Resolved at acceptance

The four parameters this ADR called out for review, settled before `Proposed → Accepted`:

1. **Retention window.** **2 days** (was 14 proposed). The visual-clutter pain on the Triage page dominates the audit-trail argument; provenance lives in the surviving Brief and the source GitHub issue.
2. **Anchor.** **`updated_at`** (as proposed). No code path mutates a closed session today; revisit by adding `closed_at` if that ever changes.
3. **Child-Brief handling.** **Nullify-`source_session_id`** (as proposed). Matches the single-delete endpoint's behavior.
4. **Schedule offset.** **09:23 UTC** (as proposed), six minutes after the Brief purge.
