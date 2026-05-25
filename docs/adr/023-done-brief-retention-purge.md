# 023. Done-Brief retention purge: pg_cron janitor for terminal Briefs

## Status

`Accepted`

Date: 2026-05-25

## Context

`done` is a terminal Brief Status. Once a Brief is accepted, it never transitions again, but its row — plus every cascade-linked Event, Run, Verification Result, Artifact, and Content Revision — lives in the Cyberbrain forever. Over a few weeks of dogfooding the Briefs View fills with accepted work that has no remaining action, and the operator clears it by deleting Briefs one at a time via `major-delete-brief`.

`SPEC.md` § Cuts records the original v1 decision: *"Artifact Cleanup Policy — Manual cleanup; no janitor job in v1."* That cut was about not building artifact-blob garbage collection. It is now in tension with day-to-day operability: the operator wants accepted Briefs to age out automatically, and wants a faster manual path for the rest.

This ADR reverses the cut **narrowly** — only for retention of terminal `done` Briefs — and leaves artifact-blob cleanup untouched.

### What "3 days old" anchors on

`major.briefs` has `created_at` and `updated_at` but no `done_at`. Three candidate anchors:

1. **The `status-transitioned` → `done` Event's `created_at`** (chosen). Every path into `done` — UI `major-confirm-qa` and the ADR 007 PR-merge webhook — writes a `status-transitioned` Event with `payload.to = 'done'`. This is the precise, immutable "became-done" time, and it is Metadata (a structured Event), not Content, so reading it respects axiom 2.
2. **`updated_at`.** Approximate. For a terminal Brief it is *usually* the done time, but a `pull_request` webhook (ADR 021 overwrites `pr_derived_facts`) can touch a merged PR's Brief after `done`, dragging `updated_at` forward and delaying purge unpredictably.
3. **`created_at`.** Wrong semantics — a Brief authored weeks ago but accepted today would be purged the instant it reaches `done`.

We anchor on (1), falling back to `updated_at` only for legacy `done` Briefs that predate the `status-transitioned`/`done` Event convention and therefore have no such Event.

### Does a background delete violate "agents propose, humans apply"?

Hard rule 3 (`AGENTS.md`) forbids mutating Briefs *as a side effect of chat or agent reasoning*; lifecycle state changes flow only through Triage Change Operations and Run Finalization. The purge is neither: it is a deterministic, operational **retention sweep** with no reasoning and no lifecycle transition — `done` is already terminal; the row is removed, not moved. This is the same category as the Lease-Expiry Reaper (`major.reaper_sweep`), an existing pg_cron background job that mutates Briefs. The purge follows that precedent.

Acceptance remains human-only (boundary 10): the purge only ever touches Briefs a human already drove to `done`.

### How to wire the cron

The Reaper is invoked by pg_cron, but its schedule is **not in the repo** — it was registered manually in the Supabase dashboard (no `cron.schedule` exists in any migration; `docs/runbook.md` line 93 was stale and is corrected alongside this ADR). Two options for the purge:

1. **Pure-SQL pg_cron job, registered in a migration** (chosen). pg_cron runs inside Postgres, so it can `select major.purge_done_briefs(3)` directly — no edge function, no `net.http_post`, no service-role key in cron SQL, and the entire job (function + schedule) is captured in one migration with zero manual dashboard steps.
2. **Mirror the Reaper** — a `major-purge-done-briefs` edge function calling an RPC, scheduled via an HTTP `net.http_post`. Consistent with the Reaper and pokeable over HTTP, but it would also require a manual dashboard registration (the URL + key cannot live in a migration), reintroducing the exact gap this ADR documents.

### Bulk manual delete

The companion UI feature (multi-select on the Briefs View) deletes the selected Briefs by calling the existing `major-delete-brief` once per id, client-side. No new bulk endpoint: the single-delete function already enforces the `agent-running` guard and the cascade, and the selection counts are small (a handful of rows). A dedicated atomic bulk endpoint is deferred until volume or all-or-nothing semantics demand it.

## Decision

**Add a pure-SQL pg_cron janitor that permanently deletes `done` Briefs once they have been `done` for ≥ 3 days.**

- New migration `20260525000006_purge_done_briefs_cron.sql`:
  - `major.purge_done_briefs(retention_days int default 3) returns integer`, `SECURITY DEFINER`, `search_path = ''`. Deletes `major.briefs` where `status = 'done'` and `coalesce(<latest status-transitioned→done Event created_at>, updated_at) < now() - make_interval(days => retention_days)`. Writes one `briefs-purged` Telemetry Record carrying the deleted count and retention window. Returns the count.
  - `cron.schedule('major-purge-done-briefs', '17 9 * * *', $$ select major.purge_done_briefs(3); $$)`, registered idempotently (unschedule-if-exists first). Daily cadence is sufficient for a 3-day window.
- Cascade delete via existing FKs removes the Brief's Events, Runs, Verification Results, Artifacts, Content Revisions, and Relationship edges.
- Scope is **`done` only**. `wontfix` is also terminal but is left for manual deletion (now eased by multi-select). Broadening to `wontfix` is a one-line predicate change in a future migration if wanted.
- Retention is the function's default argument (`3`), not a UI setting. If the operator wants a different window, supersede the schedule in a new migration. No `path_blocker_config`-style row; YAGNI.

**Companion UI:** multi-select checkboxes on the Briefs View with a bulk-delete action that loops `major-delete-brief` over the selection. `agent-running` Briefs are not selectable (mirrors the single-delete guard).

## Consequences

**Positive:**
- Accepted work ages out of the Cyberbrain automatically; the Briefs View stays focused on live work.
- The whole job (function + schedule) is captured in a migration — reproducible on a fresh project, no dashboard step, unlike the Reaper.
- Purge time is precise (the done-Event timestamp), unaffected by post-merge webhook churn on `updated_at`.
- Each sweep is observable via the existing `major.telemetry_records` surface (`observation_type = 'briefs-purged'`) and pg_cron's `cron.job_run_details`.

**Negative:**
- Permanent, irreversible deletion. A Brief purged in error (e.g., accepted prematurely) is gone, including its audit Events. The 3-day window is the only grace period.
- Reading the `status-transitioned`/`done` Event couples the purge to that Event convention. If a future path reaches `done` without writing it, those Briefs fall back to the `updated_at` anchor (looser) rather than failing to purge.
- Cascade delete of a `done` parent Brief removes its relationship edges to still-live children (the child rows survive; only the edge is dropped). Acceptable at v1 scale.
- pg_cron jobs are global to the shared dev project (also HealthBite's). The job name is namespaced `major-purge-done-briefs` to avoid collision.

**Follow-on work:**
- `db/types.ts`: add `'briefs-purged'` to `KnownTelemetryObservation`.
- `docs/runbook.md`: correct the stale "schedule registration is in the migration" line for the Reaper; add a purge-job operations subsection (verify, change retention, unschedule).
- `docs/failure-modes.md`: note the purge job under scheduled-job behavior.
- Revisit: promote retention to a configurable setting, broaden to `wontfix`, or add an atomic bulk-delete endpoint only if real usage demands it.
