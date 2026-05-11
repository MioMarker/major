# 016. `merge-blocked` Brief status for Mode 1 attempt failures

## Status

`Proposed`

Date: 2026-05-11

## Context

Mode 1 (one-press merge-all of `ready-for-review` Briefs) iterates through eligible Briefs and attempts to approve + merge each one's PR. Some attempts fail. The Mode 1 grilling identified four classes:

- Merge conflict (`mergeable: CONFLICTING`).
- Required CI red (`statusCheckRollup` has failure).
- Unresolved review threads.
- Branch protection rejects merge for any other reason GitHub surfaces.

Today, `major.briefs.status` has eight values (`supabase/migrations/20260509000000_initial_schema.sql:30-32`):

```
ready-for-triage | needs-info     | ready-for-agent | agent-running |
ready-for-review | ready-for-human | done            | wontfix
```

When a Mode 1 attempt fails, there is no status that says "this is mergeable in principle but the last attempt didn't get over the line." The closest existing options are inadequate:

- **Stay at `ready-for-review`.** The Brief looks indistinguishable from one Mode 1 has not yet touched. The failure reason — visible to the user during the run via the live progress panel — disappears the moment the tab closes (Q6 chose tab-bound UX with no persistent run table). On the next Mode 1 press, Major re-attempts every `ready-for-review` Brief, including the ones that just failed for deterministic reasons (a merge conflict won't have resolved itself). The audit trail in `events` carries the reason, but `briefs.status` does not surface it.
- **Demote to `ready-for-human`.** Wrong semantics. `ready-for-human` means "an agent gave up and a human needs to intervene." A merge-blocked Brief usually has a clean PR that *will* merge as soon as the underlying GitHub-side issue resolves (CI flake passes, branch rebases, conflict gets resolved). It is not an agent failure; it is a merge-time failure.
- **Demote to `wontfix`.** Terminal; loses the work entirely. The next Mode 1 press would skip it, requiring an operator to "un-fix" the Brief. Wrong direction.

The Q9 of the grilling decided Mode 1 pulls `ready-for-review` AND `merge-blocked` in its queue, so the auto-retry loop closes without operator action when the underlying issue is fixed. That decision requires a status value that exists in the schema.

This ADR introduces that value, defines its transitions, and updates the migration / type surfaces accordingly.

### Alternatives considered

1. **No new status; keep failure reason only in `events`.** Rejected. The brief list view drives operator decision-making and is queried by `status`; without a status signal, merge-failed Briefs are invisible until clicked. Polling `events` per row to render badges is a performance and UX regression. Status is the right place for a state that the lifecycle reads.

2. **New nullable column `briefs.merge_attempt_state` (`null | 'blocked'`) alongside `status`.** Rejected. Two columns expressing one lifecycle state invite drift. The Mode 1 query would be `status = 'ready-for-review' AND (merge_attempt_state IS NULL OR merge_attempt_state = 'blocked')` — workable but worse than `status IN (...)`. Status enum extension is the simpler shape.

3. **New status `merge-blocked` (chosen).** Single source of truth. Mode 1 query is `status IN ('ready-for-review', 'merge-blocked')`. Briefs view badge derives from `status`. Auto-retry semantics are clean: a successful Mode 1 retry transitions `merge-blocked → done` (or via the existing PR-merge webhook path); a manual GitHub merge by the operator hits the same webhook and transitions to `done`; a manual PR close (not merge) transitions to `wontfix` per ADR 007. All paths converge on existing handlers.

4. **Sub-state of `ready-for-review` via a label-style mechanism.** Rejected — same drift problem as alternative (2), with the added complexity that label storage doesn't exist yet. Out of scope.

### Forces

- **The status enum is what the lifecycle code reads.** `db/types.ts` `BriefStatus` derives from this constraint; SQL queries `WHERE status = ...` are the primary lifecycle gate. Adding the value here propagates correctly through every consumer.
- **`status` is a check-constrained `text` column, not a Postgres enum type.** Per `.claude/rules/db/migrations.md`, this means the migration is "non-trivially additive" — changing the constraint changes query semantics for code that already reads `status`. ADR-required.
- **ADR 007's webhook handler must accept `merge-blocked → done` and `merge-blocked → wontfix` transitions.** The handler today writes the transition without checking the source state (it only no-ops if the target is already terminal). The new status fits without modification — but the implementation needs a regression check confirming that.
- **Operator UX surface exists.** `ui/app/(authenticated)/briefs/` has a list view that filters and groups by status. A new status without a badge / colour / sort-position is invisible. UI work is required alongside the migration.
- **Mode 1 has not shipped yet.** No live Brief is in `merge-blocked` today. The migration is purely additive at the schema level and has no data backfill.
- **Idempotency on the `status-transitioned` event.** Per `.claude/rules/functions/edge-functions.md` § Idempotency, the Mode 1 transition write must carry a stable idempotency key. The key derives from `(brief_id, "status-transitioned", actor, merge_run_id, pr_attempt_seq)` — the merge-run-scoped sequence guarantees retries on the same attempt are no-ops while distinct attempts are recorded distinctly.

## Decision

Add `merge-blocked` to the `major.briefs.status` check constraint. Define its incoming and outgoing transitions as below; update consumers (`db/types.ts`, UI list view, Mode 1 edge function) in the same change set.

### Status enum after this ADR

```
ready-for-triage | needs-info     | ready-for-agent | agent-running |
ready-for-review | ready-for-human | merge-blocked  | done | wontfix
```

### Transition rules

| From | To | Trigger | Actor | Notes |
|---|---|---|---|---|
| `ready-for-review` | `merge-blocked` | Mode 1 per-PR attempt fails any pre-flight or merge call | `human:<merge-run-initiator>` | Reason recorded in the `status-transitioned` event payload (`merge_attempt_failed_reason`, `pr_url`, `github_response`). |
| `merge-blocked` | `done` | (a) Mode 1 retry succeeds. (b) ADR 007 webhook: PR merged on GitHub. | (a) `human:<merge-run-initiator>` (b) `human:<pr.merged_by.login>` | ADR 007's handler already writes this transition for any non-terminal source. |
| `merge-blocked` | `wontfix` | ADR 007 webhook: PR closed without merge. | `human:<pr.closed_by.login>` | Same path as `ready-for-review → wontfix`. |
| `merge-blocked` | `ready-for-review` | Operator manually resets via UI ("Reset merge state" button). | `human:<operator>` | Optional in v1; needed only if the operator wants to remove the `merge-blocked` flag without retrying. |
| Any other source → `merge-blocked` | — | Disallowed | — | Only Mode 1 produces this status. |
| `merge-blocked` is **not** a terminal state | — | `pr_status` may still update via webhook. | — | The Brief continues to participate in normal lifecycle paths. |

### Schema change

A new migration (timestamped) drops the existing check constraint and recreates it with `merge-blocked` included. Idempotent shape (`if exists` / `if not exists` where supported):

```sql
-- supabase/migrations/<ts>_add_merge_blocked_status.sql
-- Implements docs/adr/016-merge-blocked-brief-status.md

alter table major.briefs
  drop constraint if exists briefs_status_check;

alter table major.briefs
  add constraint briefs_status_check
  check (status in (
    'ready-for-triage', 'needs-info', 'ready-for-agent', 'agent-running',
    'ready-for-review', 'ready-for-human', 'merge-blocked',
    'done', 'wontfix'
  ));
```

No data migration. No existing Brief is in `merge-blocked`; the constraint change is purely additive.

### Type surface

`db/types.ts` `BriefStatus` adds `'merge-blocked'`. Per `.claude/rules/ui/conventions.md`, the UI consumes this type directly; any switch/match over `BriefStatus` in the UI gains a new exhaustive branch.

### Mode 1 query

The Mode 1 edge function (proposed `major-merge-batch` or its eventual name) selects:

```sql
select id, classifications, pr_url, git_repository_ref, ...
  from major.briefs
 where status in ('ready-for-review', 'merge-blocked')
 order by /* tier sort per classifications, then PR# ascending */;
```

Per the Mode 1 grilling Q9, both statuses are pulled into the same queue. No distinction is surfaced to the user.

### UI surface

Briefs list view renders `merge-blocked` with:

- A neutral-to-amber badge ("merge blocked") distinct from `ready-for-review`.
- The most recent `merge-attempt-failed` event's reason as a tooltip / inline annotation.
- Default sort position alongside `ready-for-review` (these Briefs are still queue-eligible).

The Brief detail view shows the merge-attempt history (a filtered events listing). No new UI surface beyond what `events` already feeds.

### Event payload shape

The `status-transitioned` event written on `ready-for-review → merge-blocked` carries:

```jsonc
{
  "from": "ready-for-review",
  "to": "merge-blocked",
  "merge_run_id": "<uuid>",
  "pr_url": "https://github.com/MioMarker/major/pull/121",
  "merge_attempt_failed_reason": "merge-conflict",     // one of a closed set
  "github_response": { "status": 405, "message": "..." }
}
```

Closed set of `merge_attempt_failed_reason` values for v1: `"merge-conflict"`, `"ci-red"`, `"unresolved-review-threads"`, `"draft"`, `"approval-rejected"`, `"merge-rejected"`, `"unknown"`. The closed set is enforced by the Mode 1 algorithm, not by a DB constraint (events.payload is JSONB).

### What this ADR explicitly does not do

- **Does not define the Mode 1 algorithm or UI.** Algorithm-level decisions (pre-flight order, polling for pending CI) are deferred to ADR 017. UI placement of the Mode 1 button and progress panel is implementation work that follows.
- **Does not introduce a `merge_runs` table.** Mode 1 v1 is tab-bound (Q6); the merge_run_id in the event payload is a client-side correlation id, not a persisted row. A future "Mode 1 persistent runs" ADR could promote it.
- **Does not change ADR 007.** The webhook handler's terminal-transition logic already works for any non-terminal source status; `merge-blocked` is non-terminal and slots in cleanly. The follow-on includes a regression check, not a code change.

## Consequences

### Positive

- **Failure reason persists across tab closes.** The status badge is visible on every page load; the event payload carries the reason for click-through.
- **Mode 1 auto-retry loop closes cleanly.** Operator fixes the underlying issue, presses Mode 1 again, the Brief flows back to `done`. No manual status reset required.
- **Briefs view stays the single source of truth.** Status-driven filtering, sorting, and badge rendering all extend naturally. No "events shadow status" UI logic.
- **ADR 007 / 011 paths unaffected.** Webhook-driven merge / close transitions still work; the new source state is just another non-terminal case they already handle.

### Negative

- **Schema migration.** Adds one row to the migration history. Trivial to apply, but the brief moment of "constraint dropped, constraint re-added" exists. Wrapping the two statements in `begin; ... commit;` per `.claude/rules/db/migrations.md` § Defensive Patterns mitigates.
- **Type and UI surfaces gain a new branch.** Every exhaustive switch on `BriefStatus` requires an update. Caught at compile time via `db/types.ts`; not a runtime risk.
- **More taxonomy to maintain.** The status enum was small enough to hold in working memory; adding a ninth value pushes against that. `docs/CONTEXT.md`'s glossary needs a new entry.
- **Operator can confuse `merge-blocked` with `ready-for-human`.** Both look "stuck" at a glance. The follow-on UI work (distinct badge, tooltip) is what keeps them separable.

### Follow-on work

- **Migration file.** `supabase/migrations/<ts>_add_merge_blocked_status.sql` with the constraint update. Reference this ADR in the leading comment.
- **`db/types.ts`.** Add `'merge-blocked'` to `BriefStatus`. Verify all consumers handle the new branch.
- **`docs/CONTEXT.md` glossary.** New entry for "Merge-Blocked Brief: a Brief whose PR was approved-ready but the most recent Mode 1 merge attempt was rejected (conflict, red CI, etc.). Re-eligible for Mode 1 retry without operator action."
- **`SPEC.md`.** Lifecycle section diagram and prose update.
- **UI.** Briefs list view: badge, sort position, filter chip. Brief detail view: surface the latest `merge-attempt-failed` event's reason.
- **Mode 1 edge function.** Queue query uses `status in ('ready-for-review', 'merge-blocked')`. On per-PR failure, write `status-transitioned` event with the payload shape above; update `briefs.status` to `merge-blocked` in the same transaction.
- **ADR 007 regression test.** Confirm `merge-blocked → done` and `merge-blocked → wontfix` fire correctly when the webhook delivers, and that no extra events are written beyond what 007 already writes.
- **`docs/failure-modes.md`.** Add "Brief stuck in `merge-blocked` after operator fixes underlying issue but never presses Mode 1." Operator runbook: explicit retry, or use the manual UI reset (if implemented) to demote to `ready-for-review`.

### Revisit conditions

- **Mode 1 persistent runs ship (a `merge_runs` table arrives).** The `merge_run_id` in the event payload becomes a real FK; consider whether the status itself should carry a pointer.
- **`merge-blocked` consistently produces the same Brief failing for the same reason across 3+ Mode 1 batches.** Surface a stronger signal — a `permanently-merge-blocked` flag or a transition to `ready-for-human` after N consecutive failures. Treat as a backpressure mechanism.
- **`require_code_owner_review` flips on `dev`.** The transition shapes don't change, but Mode 1's per-PR algorithm gains a new failure class ("approval insufficient"). Reason-code enumeration would extend.

## References

- `supabase/migrations/20260509000000_initial_schema.sql:28-32` — current `briefs.status` check constraint.
- `db/types.ts` — `BriefStatus` union; this ADR adds one variant.
- `.claude/rules/db/migrations.md` — append-only migration policy; this ADR triggers because the change is not "trivially additive."
- `.claude/rules/ui/conventions.md` — UI consumes `BriefStatus` directly; the new branch propagates.
- ADR 007 — webhook-driven `→ done` / `→ wontfix` transitions; this ADR slots a new non-terminal source state into existing handlers.
- ADR 015 — bot identity; prerequisite for Mode 1 producing `merge-blocked` Briefs in the first place.
- ADR 017 — Mode 1 pre-flight algorithm; the source of the `merge-attempt-failed` reasons enumerated here.
