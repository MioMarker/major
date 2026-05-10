# 014. Run retry budget: per-Brief cap, resets on new Content Revision, auto-attempt below cap

## Status

`Proposed`

Date: 2026-05-10

## Context

ADR 012 collapsed every non-success Run disposition into "park at `ready-for-human`" and explicitly deferred a budgeted retry mechanism to a future ADR with concrete trigger criteria. Its "Revisit conditions" named the trigger: "≥3 Briefs in a one-week window where a human re-armed and the second Run succeeded — i.e. evidence that a budgeted retry would have saved the human round-trip."

The intake-and-stubs plan (`docs/plans/intake-and-stubs/00-briefing.md`) Phase 2 picks this up as a precondition for wiring the Repair Tachikoma: Repair's value is conditional on having clean retry semantics. A Repair Run that fires identically to the failed Implementer Run is just a re-roll of the same dice; what makes Repair useful is (a) bounded retry and (b) richer context on the second attempt. Both of those are decision-class.

This ADR makes the three decisions: budget shape, automation point, and what context the Repair Tachikoma sees beyond the Brief snapshot.

### What ADR 012 left open

- **Budget shape.** Per-Brief cap? Per-failure-class cap? Reset rule on Content Revision? Where the counter lives.
- **Auto vs manual.** Does Repair fire automatically when the Shell sees a failed Run below the budget, or only on a human "Re-arm as Repair" click?
- **Repair inputs.** Beyond the Brief snapshot the Implementer already gets, what additional context does Repair receive — last transcript? Verification payloads? Branch state diff?

### Forces

- **Tight-reclaim hazard.** ADR 012 was triggered by Brief 10's 148-Run loop. Any auto-retry mechanism must structurally prevent that recurring. A naive "increment counter, reclaim immediately" pattern reproduces the same hazard if the counter doesn't bind tightly.
- **A new PRD is a new task.** If Triage edits Brief Content with more guidance after a failure, the next Run is operating on a different specification. Counting prior attempts against the new attempt would conflate "the LLM tried and failed" with "the task changed under it." The reset rule has to honor this.
- **Budgeted retry has to add information.** A Repair Run that sees nothing more than the Implementer Run had is a re-roll. The Tachikoma's failures are usually deterministic at the LLM level — it makes the same mistakes given the same context. To meaningfully differ, Repair must see *something* the failed Implementer didn't: the diagnostic from the prior attempt at minimum.
- **AGENTS.md hard rule #2 (Content vs Metadata).** The retry counter and cap are metadata; they live in structured columns. Brief Content stays opaque.
- **AGENTS.md hard rule #4 (Single Active Run Rule).** Repair Runs must not race the original failed Run — the original has terminated by the time Repair fires. The partial unique index on `runs(brief_id) where outcome='running'` still holds.
- **Two-dev queue.** Auto-retry is a throughput win only if the alternative is a human round-trip. If failures cluster on a single Brief, the human still needs to see it eventually — the budget caps the auto-loop so a human's attention is the eventual backstop, not the first responder.

### Alternatives considered

#### Budget shape

1. **Per-Brief cap (`briefs.max_attempts`) + per-Run counter (`runs.attempt_number`), reset on new Content Revision (chosen).** Counter increments on each Run for a Brief; resets to 0 when `brief_content_revisions` gets a new row for that Brief. Each Brief carries its own cap (system default `3`, override per-Brief via Triage). Honors the "new PRD = new task" principle, keeps the cap user-configurable for risky Briefs, and makes the counter trivially queryable.

2. **Per-Brief cap, no reset.** Counter increments on every Run forever. Simpler but conflates retries-after-PRD-edit with retries-after-failure. A meaningfully revised Brief can't get fresh attempts without a human resetting the counter manually. Rejected — Triage-driven Content edits are the primary path to "now try this differently," and the auto-retry has to recognize that the task changed.

3. **Global system default only (one number for all Briefs).** Single config row, no per-Brief override. Simplest schema change. Rejected because (a) Briefs vary in inherent difficulty and (b) the operator path of "this Brief deserves an extra attempt" is real (an edge case in the codebase, a known-flaky test) and worth supporting from the start rather than retrofitting.

4. **Per-failure-class cap (separate caps for sandbox-CI red vs scope-bail vs subprocess error).** Maximum granularity. Rejected for v1 — we don't have data on which failure classes are worth distinct retry policies, and adding the dimension preemptively bloats the schema without payoff. Revisit if usage demands it.

#### Auto vs manual

1. **Auto-attempt below budget; human re-arm always (chosen).** If `attempt_number < max_attempts`, the Shell's next poll re-arms the Brief to `ready-for-agent` with `purpose=repair` on the claim and a Repair Tachikoma runs against the same branch. Above budget, Brief parks at `ready-for-human`. Human can always click "Re-arm as Repair" to bypass the budget when they have additional context. Captures the throughput win (transient failures recover without a human) while keeping the human override.

2. **Manual only.** Every failure parks at `ready-for-human`; human decides re-arm. Matches ADR 012 exactly; loses the throughput win that motivated this ADR.

3. **Auto-attempt with exponential cooldown.** Auto-retry below budget but with backoff (5min → 30min → 2hr). Rejected — the tight-reclaim hazard ADR 012 named is prevented structurally by the budget itself (`attempt_number < max_attempts` is bounded), not by cooldown. Adding a cooldown timestamp is a separate axis of complexity; if a Brief is failing 3× in 5 minutes, the budget caps it at 3 attempts and parks. No timer needed.

#### Repair inputs

1. **Brief snapshot + last failed Run's transcript excerpt + Verification Results (chosen).** Repair sees the Brief (same as Implementer), the tail of the prior Tachikoma's transcript (bounded — last ~4KB, sanitized), and the structured `verification_results` rows the prior Run produced. Enough context to (a) recognize *what* failed and (b) try a different approach. Skips the full transcript to keep prompt size bounded and the budget readable.

2. **Brief snapshot only.** Repair starts blind. Cheapest, fully deterministic, but functionally a re-roll. Rejected.

3. **Brief snapshot + full transcript + Verification Results + branch state diff.** Maximum context. Two risks: (a) huge prompt sizes when the prior Run was long, eating Tachikoma turn budget; (b) the prior transcript may anchor the LLM on the same wrong path it already failed at. Rejected — bounded transcript excerpt captures most of the signal without the anchoring risk.

## Decision

### Schema changes

A new migration adds:

```sql
alter table major.briefs
  add column max_attempts integer not null default 3;

alter table major.runs
  add column attempt_number integer not null default 1;

-- Reset attempt counter on new Content Revision. A new revision means
-- the task changed; prior attempts shouldn't count against the new attempt.
-- Enforced in the major-claim-brief Run Start Transaction: when claiming,
-- if the Brief's current_revision_id is greater than the latest Run's
-- started_against_revision_id, attempt_number resets to 1.
```

`briefs.max_attempts` defaults to `3` for new Briefs. Existing Briefs get `3` via the column default. Triage can override per-Brief through a new `set-max-attempts` Triage Change Operation type (separate PR, not in this ADR).

`runs.attempt_number` is set during the Run Start Transaction:

```sql
-- Pseudocode in major-claim-brief RPC:
--   latest_run := most recent run for this brief (any outcome)
--   if latest_run is null OR brief.current_revision_id > latest_run.started_against_revision_id:
--     attempt_number := 1
--   else:
--     attempt_number := latest_run.attempt_number + 1
```

### Auto-retry decision (Shell side)

`shell/main.ts:executeRun` finalization gains a check before parking:

```ts
// After determining nextStatus = "ready-for-human":
if (claim.run.attempt_number < claim.brief.max_attempts) {
  // Auto-retry path: re-arm to ready-for-agent so the next poll claims as Repair.
  nextStatus = "ready-for-agent";
  // The next claim's run.purpose will be 'repair' (see below).
}
```

The next claim is structured as a Repair Run (`runs.purpose = 'repair'`). `major-claim-brief` recognizes that the Brief's latest Run terminated as `failed` and the next claim should fire as `purpose=repair`. The Shell's `executeRun` dispatches on `claim.run.purpose`:

- `execute` → existing pipeline (planner-gated → implementer → reviewer).
- `repair` → Repair Tachikoma (new function `runRepair` in `shell/main.ts`).

### Repair Tachikoma inputs

Beyond the existing `/work/.major/brief.json`, the Shell writes:

- `/work/.major/inspected_run.json` — the failed Run's row (`id`, `outcome`, `cancellationReason`, `started_at`, `ended_at`, `final_text`).
- `/work/.major/inspected_run_verifications.json` — the failed Run's `verification_results` rows (check_name, outcome, payload).
- `/work/.major/inspected_run_transcript_tail.txt` — last ~4KB of the failed Tachikoma's transcript, sanitized via the existing secret sanitizer.

The Repair Tachikoma prompt (`shell/prompts/repair.md`, already a developed stub) is amended to instruct the Tachikoma to: (a) read these three files first to understand what went wrong, (b) form a hypothesis about why the prior attempt failed, (c) attempt the Brief differently. Repair's job is to ship a PR — same artifact contract as Implementer. (The existing `repair.md` stub frames Repair as an inspector that recommends a disposition; this ADR re-scopes it to a second-attempt implementer that has access to the prior failure's diagnostics. A successor ADR may split inspect-only Repair from retry-Repair if the use cases diverge.)

### Human override

The Re-arm button (PR #55) gains a second affordance: "Re-arm as Repair." This always fires a Repair Run regardless of budget. The button calls a new edge function `major-rearm-brief` (or extends the existing UI mutator) that:
1. Sets `briefs.status = 'ready-for-agent'`.
2. Sets the next-claim `purpose` to `repair` via a coordination flag (separate from `attempt_number`).
3. Records an Event with `actor = 'human:<login>'` and `payload.reason = 'human-override-rearm-as-repair'`.

A human override does NOT reset `attempt_number`. If the human re-arms a Brief that's already burned its budget, the next attempt is `attempt_number = max_attempts + 1` — the cap is for auto-retry only.

### What this ADR explicitly does not do

- **Does not introduce a separate `failed-retryable` Brief status.** The Brief still transitions to `ready-for-agent` between Run failures; what changes is the next Run's `purpose`. This keeps the lifecycle state machine unchanged.
- **Does not change the auto-retry to use a cooldown timer.** ADR 012's tight-reclaim hazard is prevented by the budget (`attempt_number < max_attempts`), not by a delay. Briefs that fail fast cap at `max_attempts` attempts within seconds; that's a known-bounded loop, not the unbounded one ADR 012 closed.
- **Does not extend Repair to a third or fourth attempt-of-attempts.** Repair is the second attempt (or third, up to `max_attempts`). All attempts after the first execute Run are Repair Runs.
- **Does not couple to ADR 010/011** (Triage intake). The retry mechanism works regardless of how the Brief was created.
- **Does not surface attempt history in the UI beyond a single counter badge.** The Brief Detail view can show "attempt N of M" but the full per-attempt diff/transcript view is follow-on.

### Numbering note

Per ADR 012's "working title `013 — Run retry budget`," this was tentatively `013`. ADR 013 was already taken by the Planner output contract (PR #57). Numbers `010` and `011` are reserved for the Phase 3 inbound/outbound ADRs. This ADR takes the next monotonic available number, `014`.

## Consequences

### Positive

- **Closes ADR 012's deferred work** with a concrete, bounded mechanism. Auto-retry below budget captures the throughput win on transient failures; budget prevents the runaway loop hazard.
- **Honors "new PRD = new task."** Counter reset on Content Revision makes Triage-driven re-attempts behave correctly without manual intervention.
- **Per-Brief override** lets the operator mark known-difficult Briefs as deserving extra attempts up front (via Triage), rather than retrofitting after a failure.
- **Repair Tachikoma has real information to differ from Implementer.** The transcript excerpt + verification results is the smallest payload that meaningfully informs a second attempt without flooding the prompt.
- **Schema additions are small and additive.** Two columns, one migration, default values backfill existing rows.
- **Repair purpose path stays inside the existing lifecycle.** No new Brief status; just a flag on the Run.

### Negative

- **`attempt_number` is computed at claim time** via a query for the latest Run. This adds one read inside the Run Start Transaction. Negligible against the rest of the transaction, but non-zero.
- **Repair Tachikoma may echo-chamber.** Reading the failed transcript can anchor the LLM on the same wrong approach. Mitigated by (a) bounded transcript excerpt and (b) prompt instructions to "form a hypothesis about why prior attempt failed" before retrying. If echo-chamber proves real in practice, the mitigation is to drop the transcript excerpt and rely on Verification Results only — that's a prompt edit, not a schema change.
- **Re-scoping Repair from inspector to retry-implementer** abandons the existing `repair.md` stub's "I recommend a disposition" framing. The stub was never wired; abandoning it now costs nothing. But operators reading the prompt history may wonder why the role changed. The ADR is the explanation.
- **Above-budget Briefs still need a human.** The budget caps auto-retry; truly stuck Briefs still consume operator attention. The win is "operator attention only when auto-retry would have failed too," not "no operator attention ever."
- **Counter-reset semantics depend on Triage actually creating new Content Revisions** when the PRD changes. If Triage edits Content in-place (which it shouldn't per AGENTS.md hard rule "Editing Brief Content directly without creating a Content Revision"), the counter doesn't reset. The Triage path already obeys this rule.

### Follow-on work

- **Migration**: `db/NNNN_run_retry_budget.sql` adds `briefs.max_attempts` (default 3, not null) and `runs.attempt_number` (default 1, not null). Append-only.
- **`major-claim-brief` RPC**: amend to compute `attempt_number` based on prior Run + Content Revision comparison; set `runs.purpose='repair'` when prior Run terminated as `failed`.
- **`shell/main.ts`**: dispatch on `claim.run.purpose` (`execute` vs `repair`); add `runRepair` function; flip the disposition logic to re-arm below budget instead of parking.
- **`shell/prompts/repair.md`**: rewrite from inspector framing to retry-implementer framing. Bump `REPAIR_PROMPT_VERSION` per AGENTS.md hard rule #7.
- **`shell/tachikoma.ts`**: write the three Repair input files (`inspected_run.json`, `inspected_run_verifications.json`, `inspected_run_transcript_tail.txt`) when `role='repair'`.
- **UI**: extend the existing Re-arm button (PR #55) with the "Re-arm as Repair" affordance. Add a small "attempt N of M" badge on Brief Detail.
- **Triage Change Operation type `set-max-attempts`**: separate ADR if needed; v1 can ship without operator-overridden caps (system default 3 covers most cases).
- **Telemetry**: emit a `retry-budget-exhausted` Telemetry Record when a Brief hits `max_attempts` and parks. Operators want to see this aggregated.
- **Slice as 3-4 PRs per the briefing**: this ADR → migration + RPC + Shell branch → Repair prompt rewrite + Tachikoma inputs → UI affordance + badge.

### Revisit conditions

- **Auto-retry causes a real incident** (echo-chamber that lands a bad PR; budget too generous for some class). Postmortem; tighten default or move to manual-only.
- **Triage Content edits become routine and the counter-reset surprises operators.** Add a UI badge "attempt counter reset on revision N."
- **Repair's transcript-excerpt input proves too anchoring.** Drop it; rely on Verification Results only.
- **A new failure class needs distinct retry policy** (e.g. flaky-test failures want more retries than scope-bails). Per-failure-class caps; this ADR is superseded.
- **Multi-Run Repair becomes meaningful** (Repair-of-Repair-of-Repair). Currently all post-failure attempts are Repair Runs counted toward the same budget; if a hierarchy emerges, separate ADR.

## References

- ADR 012 — Failed-Run disposition; this ADR is the deferred retry-budget work it named.
- `docs/plans/intake-and-stubs/00-briefing.md` Phase 2 — the plan slot this ADR fills.
- `shell/main.ts` `executeRun` — receives the dispatch-on-purpose change.
- `shell/prompts/repair.md` — the stub this ADR re-scopes.
- ADR 013 — Planner output contract; sibling pattern (decision-then-stop).
- `db/types.ts` — `Run.purpose` already includes `'repair'`; schema enum doesn't change.
- AGENTS.md hard rules #2 (Content vs Metadata), #4 (Single Active Run Rule), #7 (Prompt versioning).
