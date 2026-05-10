# 011. Outbound Brief → source GitHub issue resolution comment

## Status

`Proposed`

Date: 2026-05-10

## Context

ADR 007 wired the auto-close half of the loop: when a PR merges, the matching Brief transitions to `done`, and if `briefs.source_issue_*` is populated, the source GitHub issue is closed with a one-line comment. That ADR's scope was narrow on purpose — it closed the obvious gap (issue stays open after PR merges) without taking on the full outbound communication surface.

The intake-and-stubs plan (`docs/plans/intake-and-stubs/00-briefing.md`) Phase 3d picks up the rest: a richer comment on resolution, AND symmetric handling for the `wontfix` terminal state. The briefing flagged the trigger-state question explicitly:

> Consider whether to comment on every status change (noisy) or only the terminal ones (probably the right answer).

Plus four sub-questions: which states trigger, whether mid-lifecycle states are noisy enough to suppress, what GitHub identity authors the comment, and what the comment body says.

This ADR makes those four decisions and supersedes the comment portion of ADR 007. The close-the-issue mechanic from ADR 007 stays; the comment text is upgraded and the wontfix case is added.

### What's currently in production (post-ADR-007)

- On `pull_request.closed` with `merged=true` for a PR matched to a Brief: Brief → `done`, source issue closed (`state_reason: "completed"`) with a one-line comment "Closed by `<owner>/<repo>#<PR>` (Major Brief #N)."
- On `pull_request.closed` with `merged=false`: Brief → `wontfix`. Source issue is **not** touched. This was deliberate in ADR 007 ("closing a PR does not imply rejecting the underlying request") but produces an asymmetric audit trail — the issue stays open even though the work was rejected.
- The comment text is functional but minimal. Operators reading the issue thread don't see what was tried, what passed verification, or why the work succeeded/failed.

### Alternatives considered

#### Trigger states

1. **Terminal transitions only (`done` and `wontfix`) (chosen).** Comment on both. Aligns with the briefing's "probably the right answer" framing. Quietest path that still produces a complete loop. The issue reporter sees one comment when the matter is settled, with all the relevant context.

2. **Terminals + `ready-for-human` (intervention needed).** Comment when Brief lands at `ready-for-human` so the reporter knows manual review is happening. Rejected — well-intended but noisy. A Brief can hit `ready-for-human` multiple times in its lifecycle (failed Run → repair → failed again); each transition would emit a comment. Issue thread becomes a status log.

3. **Every status transition.** Comment on every transition. Rejected outright — every Run open/close generates noise.

#### Mid-lifecycle states

1. **No, terminals only (chosen).** GitHub already cross-links the PR ↔ issue via the `Closes #N` footer the implementer prompt emits. The reporter sees "PR opened against this issue" through GitHub's native UI; adding our comment for the same fact is redundant.

2. **Yes, comment when PR opens (`ready-for-review`).** Useful if the reporter doesn't watch GitHub's native cross-links carefully. Rejected because the cross-link IS the native mechanism for that signal; duplicating it via comment crowds the thread.

#### Comment author

1. **Existing `GITHUB_APP_TOKEN` (the same fine-grained PAT ADR 007 already uses) (chosen).** Maps to a specific GitHub account whose login appears as the comment author. Already configured per `docs/runbook.md` §1.7.1. No new auth surface, no new secret to rotate.

2. **Dedicated bot account (`MAJOR_BOT_TOKEN`).** Cleaner attribution — comment author reads as "MajorBot says…" rather than a human contributor login. Rejected for v1; adds a token to rotate, an account to provision, a permissions matrix to maintain. The current account already works. A future ADR can swap it in if attribution clarity proves valuable.

#### Comment body

1. **Full Brief summary + PR link + verification results (chosen).** Multi-paragraph: Brief title, what was attempted, PR link (or none for `wontfix` with no merge), summary of verification outcomes (`tsc-noemit`, tests, eval-gate, etc.). Verbose but context-rich. The issue reporter doesn't have to click through to know what was done.

2. **Resolution + PR link + Brief id.** Concise single-line, like the current ADR 007 comment but slightly richer. Rejected — the choice question said "verbose but context-rich" was the user's pick. The one-liner is what we have today; this ADR upgrades.

3. **Just "resolved" with a Brief link.** Minimum noise. Rejected — loses the GitHub-side jump-to-PR, and Major UI links are useful only for operators logged into Major.

### Forces

- **GitHub's native cross-link covers PR-opened.** Implementer prompts emit `Closes #N` and GitHub auto-builds the timeline cross-link. Comments for mid-lifecycle states fight that native UX.
- **Eventual consistency is acceptable.** ADR 007 established that failed comment posts are logged but do NOT block the Brief transition. This ADR preserves that posture for both `done` and `wontfix`.
- **Token permissions cover the surface.** Per ADR 007 the token already has `Issues: Write`. `Closing` an issue is `Issues: Write`; posting a comment is also `Issues: Write`. No new scope.
- **Wontfix-via-closed-PR is one path of many.** Future paths to wontfix include human reject in UI (`major-reject-brief`), webhook-driven close-without-merge (current ADR 007 case), and Run cancellation routed via `wontfix`. The comment trigger must work uniformly across them.
- **The comment is best-effort.** Same failure-mode as ADR 007 §18: a failed comment post logs but doesn't abort the Brief transition.
- **Verification result rendering must handle absence.** A Brief that hit `wontfix` without ever producing verification results (e.g. operator reject in UI before any Run) should produce a sensible comment that doesn't reference fictional checks.

## Decision

### Trigger surface

Whenever a Brief transitions to a terminal state (`done` or `wontfix`) AND has `source_issue_repo` + `source_issue_number` populated, post a resolution comment to the source GitHub issue. If the Brief is `done` and the source issue is still open, close it as well (this is the existing ADR 007 behavior, kept).

For `wontfix`:
- The source issue is also closed (state_reason `"not_planned"`).
- The comment is posted before the close, same pattern as `done`.
- This is the new behavior this ADR adds. ADR 007 left `wontfix` issues open; this ADR closes them with a comment.

For `done`:
- Behavior is mostly preserved from ADR 007 (close issue, post comment), with the comment text upgraded per the body spec below.

### Trigger points (where the post fires)

The comment is fired from the same code path that performs the terminal transition. Three trigger points exist; all use a shared helper:

1. **`major-github-webhook` `handlePullRequest` on PR-closed** (per ADR 007). Already wired for `done`; this ADR extends it to also post for `wontfix` (PR-closed without merge).
2. **`major-confirm-qa`** (human QA confirm in UI → `done`). Currently does not post; this ADR adds it.
3. **`major-reject-brief`** (human reject in UI → `wontfix`). Currently does not post; this ADR adds it.

The actual GitHub API call (`POST /comments`, `PATCH /issues/{number}` to close) is factored into a new helper `_shared/github-issue.ts` so the three trigger points don't duplicate the logic. Helper signature:

```ts
export async function postResolutionAndClose(args: {
  issueRepo: string;
  issueNumber: number;
  brief: { id: number; title: string; pr_url: string | null; status: "done" | "wontfix" };
  verificationResults: VerificationResultRow[];
  closeReason: "completed" | "not_planned";
  rejectionReason?: string | null;  // for wontfix: human handoff or close reason
}): Promise<{ ok: boolean; error?: string }>;
```

The helper:
1. Renders the comment body (template below).
2. POSTs the comment via `POST /repos/{owner}/{repo}/issues/{number}/comments`.
3. PATCHes the issue closed (`state: closed`, `state_reason` per arg).
4. Returns `{ ok: false, error }` on any failure but does not throw.

Callers log a `[major-<caller>] issue-close-failed` Telemetry Record on `ok: false` (matching ADR 007's existing failure-mode entry in `docs/failure-modes.md` §18).

### Comment body (template)

```markdown
Resolved by Major Brief #<id> — **<status: done | wontfix>**

> <brief title>

<!-- PR link block — present iff brief.pr_url is set -->
**Pull Request:** [<owner>/<repo>#<pr_number>](<pr_url>)

<!-- Verification block — present iff verificationResults is non-empty -->
**Verification:**
- <check_name>: <outcome> (required: <yes|no>)
- ...

<!-- Reason block — present iff status=wontfix AND rejectionReason -->
**Reason:** <rejectionReason>

— posted by Major (<bot_login>)
```

Body construction notes:
- Brief title comes from the title field (or the first line of the current Content Revision if title is unset).
- PR link block is omitted entirely if `pr_url` is null (e.g. a Brief rejected before any Run).
- Verification block is omitted if no verification_results exist (e.g. operator reject before any Run).
- Verification block lists at most the most-recent Run's checks, sorted: required first, then advisory.
- For `wontfix`: `rejectionReason` is drawn from the most recent `human-handoff` Event payload or the PR-closer's identity (matching ADR 007's actor-attribution).
- `<bot_login>` is whichever account the GITHUB_APP_TOKEN authenticates as; rendered for transparency.

A sample rendered `done` comment:

```markdown
Resolved by Major Brief #42 — **done**

> Add path-blocker glob editor to Settings

**Pull Request:** [MioMarker/major#48](https://github.com/MioMarker/major/pull/48)

**Verification:**
- tachikoma-implementer: pass (required)
- tsc-noemit: pass (required)
- npm-test: pass (required)
- ci-rollup: pass (advisory)
- tachikoma-reviewer: pass (advisory)

— posted by Major (some-account)
```

A sample rendered `wontfix` comment:

```markdown
Resolved by Major Brief #51 — **wontfix**

> Spike on cross-repo Brief support

**Reason:** PR closed without merging by jonathan-sells; spike concluded the feature is out of scope for v1.

— posted by Major (some-account)
```

(No PR link block since the PR was closed; no verification block if no verifications recorded; the rejection reason carries the context.)

### Idempotency

GitHub-side: re-posting a comment on the same issue creates a duplicate comment. The handler avoids that by checking whether a comment already exists with the marker text `Resolved by Major Brief #<id>` (search via `GET /repos/{owner}/{repo}/issues/{number}/comments` with a pagination cap, scan for the marker). If present, skip the post and just ensure the issue is closed.

Cyberbrain-side: the existing `status-transitioned` Event from the terminal transition is the durable record; this ADR doesn't add an Event for the comment post. Telemetry Records capture the comment-post success/failure (sibling to ADR 007's existing entries).

### What this ADR explicitly supersedes from ADR 007

- The comment body in ADR 007 (single-line `Closed by … (Major Brief #N).`) is replaced by the richer template above for both `done` and `wontfix`.
- ADR 007's "wontfix-no-issue-touch" stance is reversed: `wontfix` now closes the issue with `state_reason: "not_planned"` and posts a resolution comment. The rationale ADR 007 gave (PR-close ≠ request-rejection) is honored by the comment text explaining the reason rather than by leaving the issue open.

ADR 007's auto-close MECHANIC (the close-the-issue API call, the actor attribution rule) is preserved unchanged; just the comment text and the wontfix branch differ.

### What this ADR explicitly does not do

- **Does not comment on mid-lifecycle transitions.** `ready-for-review`, `ready-for-human`, `agent-running` etc. don't fire comments. GitHub's native PR-issue cross-link covers `ready-for-review`; the others are operator-internal.
- **Does not introduce a dedicated bot account.** Existing `GITHUB_APP_TOKEN` is the comment author. A future ADR can swap to a bot account if attribution clarity becomes valuable.
- **Does not handle reopening.** If a closed issue is reopened on GitHub, no comment is posted. The Brief's terminal state still holds; the human can manually adjust if needed.
- **Does not update an existing resolution comment if the Brief transitions twice** (e.g., `wontfix` → reverted to `ready-for-agent` by operator → `done`). The first comment stays; a second comment is posted (with the new resolution). The idempotency check is by marker presence so the second comment is structurally distinct.
- **Does not block lifecycle transitions on comment failures.** Same posture as ADR 007: comment failures are best-effort, logged via Telemetry, do not abort the Brief transition.
- **Does not gate on whether the issue is currently open.** Even if the issue is already closed (e.g., manually closed before Brief terminalized), the resolution comment is posted to the closed thread. The close-PATCH is a no-op in that case (already closed).

### Numbering note

Reserved per the briefing for outbound. This ADR takes `011` to honor the briefing's "ADR 010 = inbound, ADR 011 = outbound" mapping. ADR 010 ships alongside (see PR #62).

## Consequences

### Positive

- **Closes the resolution loop symmetrically.** Both `done` and `wontfix` produce a comment on the source issue. Issue readers see what happened without clicking through to Major UI or the PR.
- **Rich context lowers the "what happened?" question.** Verification result summary in the comment gives issue followers a complete picture: not just "resolved" but "resolved with these checks passing."
- **Reuses ADR 007's auth, attribution, and failure-mode pattern.** No new token, no new failure-mode runbook entry (sibling to existing §18). Helper extraction makes the three trigger points share one implementation.
- **Idempotent on redelivery / replay.** Marker-based duplicate detection prevents comment spam from webhook redelivery, replay-of-finalize, or operator double-click on UI confirm/reject buttons.

### Negative

- **Wontfix-closes-issue is a behavior change from ADR 007's "leave it open" stance.** Operators who relied on `wontfix` keeping the issue open as "still wanted, just not by this PR" will see the issue close. The comment body's `Reason:` line carries the nuance, but the close is a state change. Mitigation: the comment text makes the reason visible, and an operator can manually reopen if needed.
- **Rich comment is verbose.** Multi-paragraph comments crowd the issue thread more than the ADR 007 one-liner did. Mitigated by limiting the comment to terminal transitions only.
- **Marker-based idempotency is text-fragile.** If the comment template's marker line ("Resolved by Major Brief #<id>") gets edited, idempotency breaks for the version drift period. Documented in the helper's comment header so future contributors don't shift the marker without thinking.
- **Verification result rendering depends on `verification_results` being populated.** Briefs rejected via UI before any Run will have no verifications to render; the comment omits the block. Operators reading those comments see less context, but that's accurate (no Run happened).
- **Three trigger points means three places to wire the helper.** Code duplication risk is mitigated by the helper extraction, but each caller still needs the verification-results lookup + issue-coordinates lookup. Small code surface, tracked in the implementation PR.

### Follow-on work

- **Implementation PR** (per Phase 3d slicing): new `_shared/github-issue.ts` helper; extend `major-github-webhook` `handlePullRequest`'s `maybeAutoCloseBrief` to use the helper; add helper calls in `major-confirm-qa` and `major-reject-brief`.
- **`docs/failure-modes.md` §18 update**: the existing "source-issue close failed" entry needs a sub-case for "resolution comment failed but close succeeded" (and vice versa).
- **Operator runbook addition**: `docs/runbook.md` gains a small section explaining that `wontfix` now closes the source issue and what the comment will say.
- **CLAUDE.md amendment**: the "Letting agents transition Briefs to `done`" rule already has the webhook-merger clarification per ADR 007; ADR 011 doesn't change that. But the parallel rule should mention that human UI confirms/rejects ALSO close the source issue now.
- **Implementer prompt (`shell/prompts/implementer.md`) — no change required.** The `Closes #N` footer is what GitHub uses for cross-links; this ADR doesn't change that mechanism.
- **Idempotency-marker test**: a small Deno test for the helper that asserts the second invocation with same Brief id detects the existing comment marker.

### Revisit conditions

- **Comment thread crowding becomes a real complaint.** Trim the comment template; consider per-repo settings.
- **`wontfix` closing the issue produces operator surprise.** Add a per-Brief override (`briefs.close_source_issue_on_wontfix = false`) or revisit the default.
- **A bot account becomes worth the maintenance cost** (attribution clarity, audit trail). New ADR replaces the `GITHUB_APP_TOKEN` author with a dedicated bot identity.
- **Multi-Brief-from-one-issue surfaces.** When one issue produces N Briefs, deciding "the issue is fully resolved" gets policy work — first Brief closes? last Brief closes? all-terminal? This ADR assumes 1:1 per ADR 007's v1 model. Multi-Brief reconciliation is a v2 question.
- **GitHub timeline native cross-link gains the verification info natively.** Unlikely but possible; would make the verification block in the comment redundant.

## References

- `docs/plans/intake-and-stubs/00-briefing.md` Phase 3d — the plan slot this ADR fills.
- ADR 007 — Auto-close Brief and source GitHub issue on PR terminal events; this ADR supersedes the comment text and adds the wontfix branch.
- ADR 010 — Inbound GitHub issue → Triage Session; sibling outbound counterpart.
- `supabase/functions/major-github-webhook/index.ts` `maybeAutoCloseBrief` — receives the helper extraction.
- `supabase/functions/major-confirm-qa/`, `supabase/functions/major-reject-brief/` — receive the helper call.
- `docs/failure-modes.md` §18 — existing source-issue-close failure mode; receives a sub-case update.
- `docs/runbook.md` §1.7.1 — token scope (no change; existing `Issues: Write` covers).
- AGENTS.md hard rules #1 (Cyberbrain is authoritative), #6 (Idempotency keys).
- `db/types.ts` `BriefStatus` — terminal states this ADR keys off (`done`, `wontfix`).
