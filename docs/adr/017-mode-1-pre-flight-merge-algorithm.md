# 017. Mode 1 per-PR algorithm upgrade: pre-flight + approve + merge

## Status

`Proposed` (implementation deferred until triggers below fire; further grilling expected before shipping)

Date: 2026-05-11

## Context

Mode 1's initial implementation ships the minimum viable per-PR algorithm chosen in the Mode 1 design grilling Q5 path (b): "approve, then attempt merge." For each eligible Brief, Mode 1:

1. `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with `event: APPROVE` as the user.
2. `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `merge_method: "squash"`.
3. If either step fails, skip with the GitHub error string and transition the Brief to `merge-blocked` per ADR 016.

That algorithm is correct, minimal, and ships fast. It is also blunt at the edges. The grilling identified four rough edges:

- **Stale approvals on doomed PRs.** A PR with red CI or a merge conflict still gets `Pioneer18 approved` in its timeline before the merge call fails. The approval is dismissed when the next push lands (branch protection `dismiss_stale_reviews_on_push = true`), but the timeline retains the entry. Over many Mode 1 runs, audit trails grow cluttered with approve-then-fail pairs.

- **Pending CI treated as permanent skip.** A PR whose checks completed 30 seconds before Mode 1 looked may still be reported `in_progress` for a moment by GitHub's API. Algorithm (b) doesn't read CI state at all, so this manifests as "the merge call returned 405; skipped." On the next Mode 1 press, the PR succeeds — but the user sees an inscrutable failure in the first batch summary.

- **Inscrutable failure reasons.** Algorithm (b)'s reason strings are whatever GitHub returns: `405 Method Not Allowed`, `422 Validation Failed`, `409 Conflict`. The Mode 1 summary panel shows these to the user. None of them say *why* — the user has to click through to the PR to find out.

- **Wasted approval API calls.** Each `POST .../reviews` costs an API call (plus a side effect on the PR timeline) even on PRs that have zero chance of merging in this batch. Cheap in absolute terms, free to avoid if the algorithm reads the state first.

When `dev` (or the dependent repos) eventually gain required CI checks — `tsc-noemit` and a test job are the obvious candidates — algorithm (b)'s failure mode shifts from "rare" to "common." Every PR with in-progress CI becomes a skip; every PR with red CI consumes an approval before being rejected. The cost-benefit of pre-flight flips at that point.

This ADR captures the upgrade path: algorithm (d) from the grilling — full pre-flight + approve + merge — including the polling strategy for transient pending CI. **It is `Proposed` and explicitly deferred**: a follow-up grilling refines the details (polling cadence, retry budget, error classification) and an explicit "ship 017" call promotes it. Until then, the ADR sits as a captured design.

### Alternatives considered

1. **Stay on algorithm (b) indefinitely.** Rejected as long-term posture. Acceptable for "Mode 1 has just shipped" but not for "Mode 1 has shipped, repos now have required CI, audit trails are cluttered." The triggers below define when (b) becomes insufficient.

2. **Algorithm (c) — approve + auto-rebase if `BEHIND` + merge.** Rejected. `dev` does not require up-to-date branches today, so `mergeStateStatus = BEHIND` does not block merge. The rebase machinery is dead code until that policy flips, at which point an ADR specifically for the policy change is the right vehicle. Including rebase here couples two unrelated concerns.

3. **Algorithm (d) — full pre-flight + approve + merge (chosen, deferred).** Reads PR state first; bails before approving if any pre-flight check fails; polls briefly for transient pending CI. Better failure messages, no stale approvals, transient-state tolerance.

4. **Build a separate "merge-readiness" service that pre-computes eligibility outside Mode 1.** Rejected. Adds infrastructure (a cron job, a cached table, a freshness model) for what is essentially a per-attempt freshness question. The pre-flight is a few API calls per attempt; doing it in-line is simpler.

### Forces

- **GitHub's PR state API gives everything pre-flight needs in one call.** `gh pr view <n> --json mergeStateStatus,statusCheckRollup,mergeable,reviewDecision,reviewThreads,isDraft` returns each field. One round trip, then the algorithm reads memory.
- **`statusCheckRollup` reports `state ∈ { 'SUCCESS', 'FAILURE', 'PENDING', 'EXPECTED', 'ERROR' }`** per check. Pre-flight has to treat `PENDING` / `EXPECTED` differently from `FAILURE` / `ERROR`.
- **`mergeable` lags state changes by seconds.** GitHub recalculates mergeability asynchronously after a base-branch update or a force-push. `null` (recompute in progress) means "wait briefly and re-poll," not "skip permanently."
- **`reviewThreads` includes resolved threads.** Filter for `isResolved: false` before deciding.
- **API rate limits.** Authenticated GitHub PAT gets 5,000 req/hr (the bot's quota; well above any Mode 1 batch size). The pre-flight read is two API calls per PR (`gh pr view` + a follow-up if polling). Not a constraint at v1 scale.
- **Cancellation semantics matter.** When the user presses Stop mid-batch, the in-flight pre-flight call should resolve before exiting (don't leave dangling network promises). Per-PR atomicity stays at the merge-call boundary; partial pre-flight is fine to abandon.
- **The "ship 017" call is its own decision.** This ADR proposes the design and the triggers; it does not promote itself. A separate work item (an issue or a follow-up ADR session) confirms the move and possibly tightens the polling parameters.

## Decision

When triggered (see § "Triggers for shipping" below), upgrade Mode 1's per-PR algorithm from (b) to (d). The algorithm reads PR state, applies a closed-set of pre-flight checks, polls transient pending CI, and only approves + merges if the PR passes every gate.

### The pre-flight checklist

Run sequentially. First failure short-circuits and skips the PR with the named reason:

1. **`isDraft` → skip `"draft"`.** Draft PRs are author-paused; Mode 1 does not auto-merge them.
2. **`mergeable === "CONFLICTING"` → skip `"merge-conflict"`.** Operator must resolve before retry.
3. **`reviewThreads` has any `isResolved: false` → skip `"unresolved-review-threads"`.** Some thread needs human attention.
4. **`statusCheckRollup` has any `state in ('FAILURE', 'ERROR', 'CANCELLED')` → skip `"ci-red"`.** Includes the specific check name in the reason detail field for the summary.
5. **`statusCheckRollup` has any `state in ('PENDING', 'EXPECTED')` → enter poll loop.** See § "Polling pending CI" below.
6. **`mergeable === null`** (GitHub still recomputing) → enter poll loop. Treat like pending CI.
7. **`mergeStateStatus`** values *other than* `CLEAN` or `HAS_HOOKS` may indicate a transient or structural block; if not handled by checks 1–6, skip `"merge-state:<value>"`.

If the loop exits cleanly (all checks pass), proceed to approve + merge.

### Polling pending CI

When step 5 or step 6 enters the poll loop:

- Wait `pollIntervalMs` (default `30_000`).
- Re-fetch the PR state.
- Re-run checks 1–5 from the top with the fresh state.
- Up to `maxPolls` (default `3`).
- After `maxPolls` consecutive pending polls, skip `"ci-not-done"`.

The total per-PR pre-flight cost in the worst case is `1 + maxPolls` API calls (~4 calls, ~90 seconds). Acceptable for an AFK feature with a tab-bound progress panel.

The poll parameters (`pollIntervalMs`, `maxPolls`) are configurable per Mode 1 run via the UI (advanced section, defaults applied if not set). The defaults are tuned for the v1 repo set; faster repos can shrink them.

### Approve + merge

Same as algorithm (b):

1. `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with `event: APPROVE`.
2. `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `merge_method: "squash"`.

If either fails after passing pre-flight, the reason `"approval-rejected"` or `"merge-rejected"` (whichever applies) is used. GitHub's response body is captured in the event payload but not surfaced as the primary reason in the summary.

### Reason-code enumeration (binds ADR 016's payload)

The reasons Mode 1 writes in the `merge_attempt_failed_reason` field of the `status-transitioned` event (ADR 016) are exactly:

| Reason | Source |
|---|---|
| `"draft"` | Pre-flight step 1 |
| `"merge-conflict"` | Pre-flight step 2 |
| `"unresolved-review-threads"` | Pre-flight step 3 |
| `"ci-red"` | Pre-flight step 4 (with check name in detail) |
| `"ci-not-done"` | Poll loop exhausted |
| `"merge-state:<value>"` | Pre-flight step 7 |
| `"approval-rejected"` | Approve call failed |
| `"merge-rejected"` | Merge call failed |
| `"unknown"` | Unexpected GitHub response not matching above |

The closed set lives in a TypeScript const in the Mode 1 edge function; the UI summary localises each reason to operator-friendly text ("CI not done — try again later" rather than "ci-not-done").

### What this ADR explicitly does not do

- **Does not ship the upgrade.** Status is `Proposed`; the trigger conditions below gate promotion.
- **Does not introduce a `merge_runs` table.** The ADR 016 model (events with a client-side merge_run_id) is preserved.
- **Does not add a `requires_up_to_date_branch` policy on `dev`.** If that policy ever lands, the algorithm gains a rebase step; a separate ADR covers it.
- **Does not change the bot identity (ADR 015) or the `merge-blocked` status (ADR 016).** Those are prerequisites; this ADR rides on them.
- **Does not specify retry on transient API errors.** Network blips during pre-flight reads should retry (idempotent reads); transient approve/merge failures should not retry inside the per-PR algorithm (Mode 1 retries on the next batch press).

## Consequences

### Positive

- **Audit trail cleans up.** No approvals on PRs that don't merge. The PR timeline accurately reflects "approved AND merged" or neither.
- **Transient pending CI doesn't trip false skips.** The poll loop catches checks that complete during the batch.
- **Failure summaries become actionable.** "CI red: tsc-noemit failed" is meaningfully different from "GitHub returned 405." The operator knows what to fix without clicking through.
- **Forward-compatible with required CI.** When `dev` (or other repos) require CI checks, the algorithm continues to work without changes; only the frequency distribution of reason codes shifts.
- **Closed-set reason codes feed UI categorisation.** Mode 1's summary can group "all CI-red PRs" or "all conflicts" — useful for batch operator action.

### Negative

- **More API calls per PR.** Best case: 1 `gh pr view` + 1 `POST reviews` + 1 `PUT merge` = 3 calls. Worst case (poll exhaustion): 4 reads + 0 writes. Algorithm (b) is 2 calls flat. ~50% increase in API usage; well within the bot PAT's 5,000 req/hr limit.
- **More per-PR latency.** Best case adds the time of one extra `gh pr view`. Worst case adds 90 seconds of polling. A 33-PR batch with all-pending CI worst-cases to ~50 minutes; same batch on (b) is ~2 minutes (with everything failing immediately). The latency is bought back in *correctness*, not throughput.
- **More code to write, test, and maintain.** Pre-flight logic, state machine for the poll loop, closed-set reason mapping, UI localisation table. Roughly 3x the code of (b).
- **Polling parameters are tunable.** Tunable parameters drift; the defaults need a rationale captured in code comments, and the UI "advanced" surface needs validation rules.
- **`mergeStateStatus` semantics are GitHub-internal and can shift.** A new value GitHub adds (Stacker-style merges, queues, etc.) trips the fallback skip. Defensible; better than a permissive default.

### Triggers for shipping

The ADR is captured but the algorithm doesn't ship until **any** of the following becomes true:

1. **Required CI checks land on `MioMarker/major` (or any repo Mode 1 targets).** Algorithm (b)'s "skip permanently if CI is pending" becomes a frequent false skip; pre-flight + polling is the only sensible posture.
2. **A Mode 1 batch produces ≥3 stale approvals on doomed PRs in a single run.** The audit-trail-clutter argument moves from theoretical to observed.
3. **Operator-reported feedback that algorithm (b)'s failure summaries are unhelpful in real use.** Specifically: a user can't tell from the summary alone why a PR was skipped, and has to click through repeatedly. Capture this in an issue and reference it in the trigger.
4. **The Mode 1 design grilling on (d) reconvenes** and the participants explicitly call "ship 017." This is the path if the team simply decides (b) was always the rough draft.

When a trigger fires:

- File an issue against `MioMarker/major` titled "Ship ADR 017 — Mode 1 pre-flight algorithm."
- Run a follow-up grilling pass on the polling parameters (defaults may need tuning given observed CI durations).
- Implement, ship, flip this ADR's status to `Accepted`.

### Follow-on work (post-promotion)

- **Mode 1 edge function refactor.** Wrap the per-PR algorithm in a function that takes a `PrState` object (the parsed `gh pr view --json` result) and returns either `{ proceed: true }` or `{ proceed: false, reason: <ReasonCode> }`. Test the function in isolation against canned `PrState` fixtures.
- **Polling state machine.** Loop with sleep; respects the Stop signal from the live progress panel. Sleep happens in client-driven server invocations: the browser holds the loop and re-invokes the edge function after waiting; the edge function itself does not block on `setTimeout`.
- **Reason-code localisation table.** UI surface mapping each reason to operator-friendly text. Lives next to the Mode 1 summary component.
- **`merge_attempt_failed_reason` event-payload validation.** Add a Zod schema in `_shared/schemas/` for the closed-set reason and reuse it in the edge function.
- **UI advanced panel for poll parameters.** Optional in v1; can ship with defaults only and add the panel later.

### Revisit conditions

- **GitHub's merge queue / merge group feature comes into use on these repos.** Pre-flight reads change shape; the algorithm needs a queue-aware variant.
- **Mode 1 grows a "merge to `main`" path.** Currently Mode 1 only merges to `dev`. A `main`-targeting Mode 1 would carry different pre-flight rules (probably stricter — required reviews from a specific human, release notes attached, etc.).
- **Per-repo CI durations differ enough that one default polling cadence is wrong.** Move polling parameters into a per-repo config keyed off `git_repository_ref`.

## References

- ADR 015 — `major-shell-bot` identity. Prerequisite: pre-flight reads use the bot PAT.
- ADR 016 — `merge-blocked` Brief status. Binds the closed-set reason codes this ADR enumerates.
- `.claude/rules/functions/edge-functions.md` — patterns for Mode 1's edge function (auth, idempotency, JSON responses).
- `.claude/rules/common/coding-style.md` § Schema-Validated User Input — Zod schema for the reason-code payload.
- Mode 1 design grilling (chat session, 2026-05-11) — origin of the (b) → (d) tradeoff.
