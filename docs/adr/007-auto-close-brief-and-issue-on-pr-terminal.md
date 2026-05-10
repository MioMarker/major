# 007. Auto-close Brief and source GitHub issue on PR terminal events

## Status

Accepted

Date: 2026-05-10

## Context

Major opens a PR per Brief during the Run Finalization Transaction. Today the GitHub webhook handler (`supabase/functions/major-github-webhook/index.ts`) keeps `briefs.pr_status` and `briefs.pr_url` in sync as PRs open / close / merge, but it does **not** transition Brief lifecycle status on terminal PR events. The Brief stays at `ready-for-review` (or `ready-for-human` if the implementer parked it) until an operator manually flips it to `done` via the UI.

Two costs follow from that gap:

1. **Operator overhead.** Every successful Brief lands twice — once when the PR merges, again when a human marks the Brief `done`. That second click is reliably forgotten; `ready-for-review` accumulates zombies.
2. **No source-issue closure.** When a Brief originates from a GitHub issue (the `integration:github` Triage Session entry point), the issue stays open after merge. There is no schema column today that records which issue produced the Brief, so even an operator-driven close cannot be automated.

The right signal is already arriving: the `pull_request.closed` webhook fires with the merger / closer identity, the merged flag, and the PR URL. The handler just doesn't act on it. This ADR closes the loop.

### Alternatives considered

1. **Status quo — operator manually transitions Brief and closes the issue.** Rejected. The friction is high (two systems, two clicks per ship), the data exists to do it automatically, and the cost compounds with every Brief. Manual close also misattributes the `done` Event Actor (the operator clicked the button; the merger actually accepted the work).

2. **One-way PR → Brief only; never touch the source issue.** Rejected. The most common Brief flow in v1 is "GitHub issue → Triage Session → Brief → PR → merge." Leaving the issue open after merge breaks the most-visible loop and means the issue tracker continues paging humans for work that has already shipped.

3. **Polling reconciler instead of webhook-driven transition.** Rejected. We already verify webhook signatures and process other PR fields in this handler; latency is seconds. A polling reconciler is the right fallback if webhook delivery breaks (`docs/failure-modes.md` candidate), not the primary path.

4. **Bidirectional: operator-closed Brief in Major UI also closes the PR via `gh` API.** Rejected for v1 scope. There is no current pull for this — operators who close a Brief deliberately can also close the PR in two clicks. Symmetric automation doubles the outbound surface (a new `gh pr close` code path, new failure modes) without proportional payoff. Revisit if usage demonstrates a need.

5. **Track source issue on `triage_sessions` (1:N) instead of on `briefs` (1:1).** Rejected for v1. A multi-Brief-from-one-issue flow requires deciding when "the issue is fully addressed" — at first merge? at last? — which is policy work without strong evidence either way. The 1:1 model on `briefs` covers the common case cleanly; revisit when multi-Brief sessions become routine.

### Forces

- **The webhook handler already runs on every PR event** and already correlates PRs to Briefs via the `Major-brief: <id>` receipt. Adding the transition is an extension, not a new integration.
- **GitHub merge events are identifiable human acts.** The webhook payload includes `pull_request.merged_by.login` (or `closed_by`) — a real GitHub user with a verifiable identity. Recording the merger as the `human:<login>` Actor on the `done` Event preserves attribution without inventing a new "system" Actor for this case.
- **CLAUDE.md hard rule "Letting agents transition Briefs to `done`."** This rule names the failure mode it cares about: an *agent* deciding the Brief is acceptable. The webhook-driven transition does not violate that rule — the merger is human, and the merge action is the acceptance signal. The rule needs a one-line amendment to make this explicit so future contributors don't mistake the webhook handler for an agent path.
- **Single Active Run Rule still holds.** The webhook may fire while a Run is `outcome='running'`. The Brief transition out of `agent-running` flips state under the active Run; the next heartbeat from the Tachikoma fails the lease-ownership check and aborts gracefully. This is the same pattern the Reaper already uses; no new abort plumbing.
- **Idempotency is already wired.** Existing webhook Events are keyed on `(brief_id, type, actor, delivery_id)`. The new `status-transitioned` Event reuses that shape with the same delivery id; replaying a delivery is a no-op insert.
- **Token scope expansion.** Closing a GitHub issue from inside an edge function requires `Issues: Write` on each dependent repo. The webhook handler today only reads PR data and does not need write scope. This ADR adds an outbound write call; the GitHub PAT used by the function must be expanded to grant `Issues: Write` on `MioMarker/healthbite` and `MioMarker/healix`.

## Decision

On every `pull_request.closed` webhook delivery the handler additionally transitions the Brief to a terminal state and, when applicable, closes the source GitHub issue.

### Brief transition rules

| Webhook condition | Brief state transition | Actor | Source-issue side effect |
|---|---|---|---|
| `pull_request.closed`, `merged=true` | → `done` | `human:<pr.merged_by.login>` | If brief has source issue: close it with a linking comment |
| `pull_request.closed`, `merged=false` | → `wontfix` | `human:<pr.closed_by.login>` (fallback `human:<pr.user.login>` if absent) | None — closing a PR does not imply rejecting the underlying request |
| Brief already terminal (`done` / `wontfix`) | no-op | — | No-op |
| Brief in `agent-running` | Transition still applies. Active Run is left to abort on its next heartbeat (lease-ownership check fails because the Brief is no longer `agent-running`). | per above | per above |

The transition writes a `status-transitioned` Event with `from`, `to`, the merger / closer identity, and the PR URL in the payload. Idempotency key: `(brief_id, "status-transitioned", actor, delivery_id)` — same shape as existing webhook Events.

### Schema additions

A new migration adds two nullable columns to `major.briefs`:

```sql
alter table major.briefs
  add column source_issue_repo   text,
  add column source_issue_number integer;

create index idx_briefs_source_issue
  on major.briefs (source_issue_repo, source_issue_number)
  where source_issue_repo is not null;
```

`major-create-triage-session` populates these on Brief creation when the originating Triage Session was initiated by `integration:github` and the trigger payload included issue coordinates. Briefs from human-initiated triage (chat, synthetic seeds) leave the columns null.

### Source-issue close

When the merge transition fires and the Brief has a non-null `source_issue_repo` + `source_issue_number`, the handler:

1. POSTs a closing comment via `POST /repos/{owner}/{repo}/issues/{number}/comments` with body `Closed by [{owner}/{repo}#{pr_number}]({pr_url}) (Major Brief #{brief_id}).`
2. Closes the issue via `PATCH /repos/{owner}/{repo}/issues/{number}` with body `{ state: "closed", state_reason: "completed" }`.

Both calls are idempotent on GitHub's side — re-closing an already-closed issue is a no-op, and a duplicate comment from a webhook redelivery is acceptable noise (rare; bounded by GitHub's retry policy). A failed issue-close call logs the error but does **not** abort the Brief transition. Operator can manually close on next reconciliation.

### CLAUDE.md amendment

The "Common mistakes to avoid" rule "**Letting agents transition Briefs to `done`. Acceptance is human-only in v1.**" gets one clarifying line:

> The PR-merge webhook is a human path: the merger's GitHub identity is recorded as the `done` Event Actor. This is not an agent transition.

### What this ADR explicitly does not do

- **No bidirectional automation.** Operator-closing a Brief in the Major UI does not close the PR or issue. That symmetric path is a separate ADR if a need surfaces.
- **No multi-Brief issue tracking.** If a single source issue produces multiple Briefs, the first PR merge closes the issue. Other Briefs from the same issue retain their reference and can be closed manually if the operator wants distinct handling. Multi-Brief reconciliation is a v2 question.
- **No webhook polling fallback.** Webhook delivery failures are catalogued in `docs/failure-modes.md` (existing handler already documents this); this ADR does not add a reconciler.
- **No retroactive backfill.** Briefs created before this ADR have null `source_issue_*` columns even if they originated from issues. Backfill is operational, not architectural; out of scope.

## Consequences

### Positive

- **Loop closes automatically.** Merge → Brief done → issue closed. One human act, three system effects, zero follow-up clicks.
- **Audit trail strengthens.** The `done` Event records the actual merger, not the operator who happened to click "Confirm QA." Future postmortems can trace acceptance to a real human reviewer.
- **No new integration surface.** The webhook is already wired, the correlation receipt already exists, the Event idempotency pattern is reused.
- **Single source of truth.** The PR is the source of truth for "did this ship?" — not a UI button. State derives from the act, not the bookkeeping.

### Negative

- **Schema migration required.** Two nullable columns + an index. Trivial, but it lands as a migration alongside the webhook change.
- **CLAUDE.md hard rule needs amendment.** A future contributor reading the unmoderated rule could mistakenly conclude the webhook handler violates it. The amendment is one line; the cost is the precedent that hard rules have webhook-shaped exceptions.
- **GitHub PAT scope expands.** `Issues: Write` on `MioMarker/healthbite` and `MioMarker/healix`. Operator-rotation step on the monthly checklist gets one additional grant per repo.
- **Issue-close failures are eventually-consistent.** A failed `PATCH /issues/...` leaves a `done` Brief with an open source issue. The handler logs and moves on; reconciliation is operator-driven.
- **agent-running-race surprise surface.** A merge fired against a Brief whose Tachikoma is still working transitions the Brief out from under the active Run. The Run aborts cleanly via the existing heartbeat path, but the implementer's in-flight commits / branch state may need operator cleanup. This is rare (PRs can't usually open before the Run finalizes) but the ADR accepts it rather than building a "merge-wait" interlock.

### Follow-on work

- **Migration**: `db/NNNN_briefs_source_issue.sql` adds the two columns + index. Append-only, no behavior change in existing code paths.
- **`major-create-triage-session`**: populate `source_issue_repo` + `source_issue_number` when the trigger came from a GitHub issue webhook.
- **`major-github-webhook`**: extend `handlePullRequest` with the transition + issue-close logic. Service-role client already in use; no new auth.
- **GitHub PAT rotation**: add `Issues: Write` to `MioMarker/healthbite` and `MioMarker/healix` on the existing fine-grained token. Update `docs/runbook.md` § token rotation.
- **`CLAUDE.md`**: amend the "Letting agents transition Briefs to `done`" bullet with the webhook-merger clarification.
- **`SPEC.md`**: lifecycle section gains a note that `done` and `wontfix` may be reached via PR-merge / PR-close webhook paths, with the merger / closer recorded as Actor.
- **`docs/failure-modes.md`**: add "Source-issue close failed after merge" mode and the operator reconciliation path.

### Revisit conditions

- **A multi-Brief-from-one-issue flow becomes routine.** Move source-issue tracking onto `triage_sessions` and define an "all-Briefs-terminal-before-close" policy.
- **Operators want bidirectional automation.** Open the Brief-close → PR-close path as a separate ADR.
- **Webhook delivery becomes unreliable enough to drive incidents.** Stand up a polling reconciler that sweeps `ready-for-review` Briefs whose PR has terminal state in GitHub but stale `pr_status` in the Cyberbrain.
- **The "merge IS human" framing breaks down.** If GitHub introduces auto-merge bots that produce non-human merger identities at scale, revisit Actor attribution.

## References

- `supabase/functions/major-github-webhook/index.ts` — current handler; this ADR extends `handlePullRequest`.
- `db/types.ts` — `BriefStatus` (`done`, `wontfix` already terminal); `EventType` (`status-transitioned` already exists).
- `CLAUDE.md` § "Common mistakes to avoid" — the rule this ADR amends.
- `SPEC.md` § Lifecycle — terminal states; this ADR adds the webhook reach-path.
- `docs/runbook.md` § token rotation — operational follow-on.
- ADR 002 — Path-Blocker Rule (separate authorization axis; unaffected).
