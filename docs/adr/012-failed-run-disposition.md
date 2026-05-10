# 012. Failed-Run disposition: park at `ready-for-human`, defer retry budget

## Status

`Proposed`

Date: 2026-05-10

## Context

The Shell's `executeRun` chooses `nextBriefStatus` per Run outcome (`shell/main.ts:445–478`). Today four dispositions exist:

1. **Success** — `succeeded` → `ready-for-review`.
2. **PR exists + required check failed** — `failed` → **`ready-for-agent`** (auto-retry, "retry-safe per SPEC").
3. **Implementer scope-bail** (`expected-paths-insufficient`) — `failed` → `ready-for-human`.
4. **Generic implementer failure** — `failed` → `ready-for-human`.

The exception path in `mainLoop()` (`shell/main.ts:186–225`) was hardened by issue #17 — when `executeRun` itself throws, the catch handler now parks the Brief at `ready-for-human` rather than re-arming `ready-for-agent`, eliminating the runaway tight-reclaim loop documented in that issue. The fix landed with an explicit comment that "auto-retry with budget can ship later."

The same hazard remains live in disposition #2. On 2026-05-10, Briefs 11/12/13/14/16 each produced a `failed → cancelled` Run pair within seconds:

```
12:34:45.997  Run 10598 ends: failed
12:34:45.997  status: agent-running → ready-for-agent
12:34:46.335  Run 10599 starts (shell-A re-claims, 338 ms gap)
12:35:23.379  Run 10599 ends: system-cancellation (no Tachikoma turns ever ran)
12:35:44.099  human:jonathan: status → ready-for-review (manual repair)
```

Today's cases trace to a different root cause that PR #47 (issue #40 follow-up) already fixes — required verifications reported as `skipped` were tripping `allRequiredPassed=false`. After PR #47, those cases will hit disposition #1 (success) instead of #2 (failed-with-PR). But disposition #2 still re-arms unconditionally for **genuine** required-check failures (real `tsc` error, real test fail, real CI red), and that path retains the runaway-loop hazard issue #17 surfaced.

The earliest precedent: Brief 10 produced **148 Runs** between 05:43 and 08:17 on 2026-05-10. The first 130+ Runs were a tight 1–3 s/Run loop driven by a deterministic `prepareSandbox` failure (the cause issue #17 was filed against). Without a guard, a deterministic failure of any kind in disposition #2 reproduces the same shape.

### Alternatives considered

1. **Park at `ready-for-human` always (mirror dispositions #3 / #4 / exception path).** Simplest. Consistent with the post-issue-#17 stance. Loses the only existing auto-retry behaviour, which was never budgeted anyway.
2. **Add a retry budget now (`runs.attempt_number`, cap N, exponential backoff).** Correct long-term answer per issue #17's "follow-on" note. Larger surface: schema change, finalize-run logic change, Brief reset semantics, attempt counter scope. ADR-class on its own; not a same-day fix.
3. **Keep auto-retry, add only a same-Brief same-Shell cooldown.** Prevents the tight loop without changing disposition. Brittle — cooldowns mask the underlying "no progress" signal and shift the symptom rather than fix it.
4. **Make the disposition policy live in the Cyberbrain (e.g. `briefs.failure_policy`) instead of the Shell.** Right structurally — disposition is a Brief property, not a Shell property — but premature; we have one policy today.

### Forces

- The exception path already parks at `ready-for-human` (issue #17). The non-exception path differing is incoherent.
- No `runs.attempt_number` column exists. Any budgeted-retry needs a schema migration + ADR.
- A deterministic failure inside disposition #2 today loops at ~2 Runs/s with no upper bound — same hazard class as issue #17.
- The only auto-retry that disposition #2 ever performs is "claim → re-run from the same branch state," which has no mechanism to know whether the second attempt has any reason to differ from the first.
- Two devs review the queue manually; `ready-for-human` is well-staffed in v1. Losing auto-retry costs human attention but not throughput.
- A future budgeted-retry ADR will need to decide: budget per Brief? per Run-of-Brief? per failure class? Reset on Content revision? These are non-trivial questions that benefit from being answered when we have more failure-mode data.

## Decision

Disposition #2 ("PR exists, required check failed") collapses into the same disposition as #3 and #4: `failed` → `ready-for-human`.

After this ADR, every non-success terminal Run finalizes with `nextBriefStatus = "ready-for-human"`. The Shell never re-arms a Brief it just failed; only a human (or a future budgeted-retry mechanism) can return a failed Brief to `ready-for-agent`.

A budgeted-retry mechanism is **explicitly deferred to a future ADR**. That ADR is expected to introduce `runs.attempt_number`, a per-Brief cap, and a re-arm rule that only fires below the cap. When it lands, this ADR (012) will be marked `Superseded by NNN`.

## Consequences

**Positive:**
- The runaway-loop hazard in disposition #2 disappears. The shape of the bug that produced Brief 10's 148-Run saga is impossible to reproduce through any normal failed-Run path.
- The four failure dispositions in `executeRun` collapse to two outcomes (`ready-for-review` on success, `ready-for-human` on failure), making the failure-mode landscape easier to reason about.
- Coherent with the post-issue-#17 stance the exception path already takes.
- No schema change. No data migration. The fix is a one-line edit in `shell/main.ts`.

**Negative:**
- We lose the (unbudgeted, unsafe) auto-retry behaviour disposition #2 was attempting. Real transient failures (e.g. a flaky network hiccup during `npm test`) now require a human to re-arm the Brief instead of the Shell self-healing.
- The `ready-for-human` queue grows faster. Acceptable in v1 (two-dev queue, low Brief throughput); will need revisiting when Brief throughput climbs or when on-call rotates.
- Briefs that *would have* succeeded on a second attempt now sit waiting until a human notices. The cost of that wait scales with queue latency.

**Follow-on work:**
- Update `shell/main.ts:459–463` (disposition #2) to set `nextStatus = "ready-for-human"` and adjust the summary string. No other call sites change.
- Update the comment block at lines 459–463 to point at this ADR instead of the SPEC retry-safety claim.
- A regression check that confirms a failed-with-PR Run produces `nextBriefStatus = "ready-for-human"` and that the Shell does not re-claim within the next poll interval.
- A future ADR (working title: "013 — Run retry budget") will introduce `runs.attempt_number`, a `briefs.max_attempts` (or system default), and a re-arm rule. Triggering signal to write that ADR: ≥3 Briefs in a one-week window where a human re-armed and the second Run succeeded — i.e. evidence that a budgeted retry would have saved the human round-trip.
