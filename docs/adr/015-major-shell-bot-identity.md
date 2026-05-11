# 015. `major-shell-bot` GitHub identity authors all Shell-opened PRs

## Status

`Proposed`

Date: 2026-05-11

## Context

The end-of-AFK cleanup workflow has a name now — Mode 1 — and it has a blocker that this ADR resolves. The grilling session that produced the Mode 1 design also surfaced the structural problem that makes Mode 1 possible only after a GitHub-identity change.

### The branch protection facts on `dev`

`gh api repos/MioMarker/major/rules/branches/dev` returns the live ruleset:

- `pull_request.required_approving_review_count = 1`
- `pull_request.require_code_owner_review = false`
- `pull_request.dismiss_stale_reviews_on_push = true`
- `required_linear_history` — squash / rebase merge only.
- No "branch up to date" requirement; no required status checks.

The README in `.claude/rules/common/git-workflow.md` describes `dev` as enforcing "required code-owner review." That phrasing reflects historical intent but does not match the live ruleset — code-owner review is not required on `dev` today. **Any account with write access can satisfy the approval requirement.** Only the PR author is disqualified.

### The current failure mode

Every PR the Shell has opened so far has been authored by `Pioneer18` (the human user), because the Shell's `GITHUB_TOKEN` env var is a fine-grained PAT belonging to that account (`shell/.env:37`). The Tachikoma runs `gh pr create` inside the sandbox; `gh` infers identity from the token; the PR's author becomes whoever owns the PAT.

Result, observed on 2026-05-11: 33 Briefs reached `ready-for-review` with merged-able diffs (`mergeable: MERGEABLE`, `statusCheckRollup: []`, no review threads) and `mergeStateStatus: BLOCKED` — all stuck because the only person who can satisfy the 1-approval gate is `kuvekep14`. AFK throughput is bottlenecked on a second human.

### Why this is suddenly load-bearing

Mode 1's whole premise is "press one button, walk away, come back to a clean queue." The user is the admin, the user pressed the button, the user is consenting — but the user cannot post the approval that GitHub requires, because the user authored the PR. Without a separate authoring identity, Mode 1 collapses to "skip every PR; tell the user to wait for `kuvekep14`."

Three escape paths exist; the prior grilling chose path 3 explicitly.

### Alternatives considered

1. **Status quo — keep PRs authored by the human PAT; wait for the other dev to review.** Rejected. Defeats the AFK ergonomics that justify Mode 1. Throughput collapses to "one batch per `kuvekep14` review session." Doesn't scale, and doesn't match the use case.

2. **Admin-bypass on merge (`gh pr merge --admin`).** Rejected. `.claude/rules/common/git-workflow.md` says "Agents must never bypass — leave merge to the user." Mode 1 is agent-orchestrated even though the user pushed the button; building a bypass code path normalises the practice and dilutes the rule. A separate one-time use of `--admin` to clear the existing 33-PR backlog is acceptable (operational, outside the feature); embedding it in Mode 1 is not.

3. **`major-shell-bot` separate GitHub identity authors all Shell-opened PRs (chosen).** Shell's `GITHUB_TOKEN` becomes a PAT belonging to a new account, `major-shell-bot`. PRs the Shell opens are authored by the bot. The human user (`Pioneer18`) is no longer the author, so the human user is eligible to be the approving reviewer. Mode 1 becomes "approve as user + merge." The 1-approval rule is satisfied literally; no bypass.

4. **Drop the 1-approval requirement on `dev`; gate at `dev → main` release instead.** Rejected for this ADR's scope. It's a workflow-philosophy change (separate ADR-worthy decision) that weakens `dev`'s safety net to fix an authorship problem. Bot identity solves the authorship problem without touching the policy.

5. **GitHub App instead of a user account.** Rejected for v1. A GitHub App gives cleaner attribution ("opened by `major-shell-bot[bot]`") and installation-token rotation primitives, but requires App registration, webhook re-wiring for installation events, and a permissions model the Shell image doesn't currently consume. A user-account PAT is a strict cost reduction for the same effect. Revisit when the Shell becomes a GitHub App in a future ADR.

### Forces

- **Mode 1 is gated on this.** Without a non-author identity, the feature does not function.
- **Code-owner review is not required on `dev`.** Any write-access reviewer satisfies the gate. The bot does not need to be a code-owner; it just needs to not be the PR author.
- **The 1-approval rule still has value.** Eyes-on-merge is the safety net for AFK orchestration. Dropping the rule on `dev` (alt. 4) removes that net globally; bot identity preserves it.
- **ADR 011 explicitly rejected a dedicated bot account for the *comment* author.** That ADR's reasoning ("current account already works; adds a token to rotate") was correct at the time. Mode 1 changes the cost-benefit: the current account stops working for PR authorship, so the bot-rotation cost now buys two things (PR authorship + comment authorship), not one. This ADR partially supersedes ADR 011's `#GITHUB_APP_TOKEN` decision: outbound comments from the Shell shift to the same bot identity, for consistency.
- **The Shell image must not bake the bot's PAT.** Tokens stay in env vars per `.claude/rules/shell/sandbox-discipline.md` § Never. The bot account adds one secret to the monthly rotation checklist, not one secret embedded in the image.
- **CODEOWNERS gate stays human-only.** `.github/CODEOWNERS` lists `@Pioneer18` and `@kuvekep14`. The bot is *not* added to CODEOWNERS. If the rule on `dev` ever flips to `require_code_owner_review = true`, the bot's approval would not satisfy it — that's correct behaviour. The bot is an authoring identity, not a reviewing identity.
- **`main` branch unaffected.** Release PRs (`dev → main`) are human-authored deliberate acts. The bot never opens a `main`-targeting PR.

## Decision

Provision a separate GitHub user account named `major-shell-bot`. Generate a fine-grained personal access token for it scoped to `MioMarker/major`, `MioMarker/healthbite`, and `MioMarker/healix` with the minimal permissions the Shell needs:

- `Contents: Write` (commit, push branches)
- `Pull requests: Write` (open PRs, post review comments)
- `Issues: Write` (close source issues per ADR 007 / 011)
- `Actions: Read` (poll CI for future pre-flight per ADR 017)

Add `major-shell-bot` as a collaborator on each of those three repos with the **Write** role (not Admin, not Maintain). It is intentionally not added to `.github/CODEOWNERS` and intentionally not granted admin rights.

The Shell's `GITHUB_TOKEN` env var (`shell/.env`, container env) is replaced with the bot PAT. All `gh` and `git` invocations inside the sandbox — `gh pr create`, `gh pr comment`, `git push`, etc. — pick up the bot identity automatically through the token. No code changes in `shell/main.ts` are required beyond updating documentation; the env var swap is sufficient.

Edge functions that already use a GitHub token (`major-create-github-issue`, `major-import-external-issues`, `major-list-external-issues`, `major-github-webhook`'s outbound posts) **also** switch to the bot PAT. Reasoning: the bot's three repo grants cover everything Major touches, and operating from one identity simplifies attribution. The `GITHUB_TOKEN` Supabase secret is updated in the same rotation.

### What this ADR explicitly does not do

- **Does not change the merge gate.** The 1-approval requirement on `dev` stays. The bot is not added to CODEOWNERS. Approval is still the human's responsibility — the bot just removes the human from the PR-author seat.
- **Does not migrate the existing 33 stuck PRs.** They were authored by `Pioneer18` before this ADR landed; they remain in that state and get cleared via a one-time `gh pr merge --admin --squash` script (operational task outside the Mode 1 feature). Re-creating them under the bot identity would burn ~33 Shell runs to reproduce identical diffs; cost vastly exceeds the audit-trail cleanliness benefit.
- **Does not introduce a GitHub App.** When/if the Shell becomes a GitHub App for installation-token rotation and per-repo scoping ergonomics, a new ADR supersedes this one.
- **Does not let the bot transition Briefs to `done`.** ADR 007's "merge IS human" framing still applies. The webhook records the *merger's* identity (the human) as the `done` Actor — the bot never appears as a `done` Actor because the bot doesn't merge PRs (it doesn't have an approval slot and never will).

## Consequences

### Positive

- **Mode 1 becomes possible.** The 1-approval gate is satisfiable with the user as the approver. The "press once, walk away" UX is unblocked.
- **Two-dev review rule preserved literally.** A non-author reviewer approves every merged PR. The rule's spirit (eyes-on-merge) is upheld; only the *flavour* shifts from "always `kuvekep14`" to "the user, when they're the merger."
- **No bypass code paths.** Mode 1's algorithm never calls `--admin` or any equivalent. The feature reads as straightforward GitHub-API plumbing.
- **Attribution clarifies.** PR timelines read "opened by `major-shell-bot`" — an unambiguous signal of which side of the orchestrator created the PR. Easier to scan in the PR list view and easier to audit.
- **ADR 011's comment-author concern resolves.** Outbound issue-resolution comments authored by the bot read as system-generated rather than as the human user posting templated text under their own handle.
- **Forward-compatible with GitHub App migration.** All token usages are already env-var-mediated; swapping the PAT for an installation token later is a one-shot operational change.

### Negative

- **One more secret to rotate.** The bot PAT joins the monthly rotation checklist alongside the existing PATs and webhook secret. Fine-grained PATs on GitHub expire (max 1 year); the checklist gains one item.
- **One more account to provision and audit.** GitHub user account, 2FA, recovery email — operator overhead at setup time. Small but non-zero.
- **`Pioneer18`-authored PRs in history don't go away.** The 33 existing PRs (and any future manually-authored PR) retain human authorship. Audit trails will show a transitional period where authorship switches from human to bot. This is acceptable; the transition itself is information.
- **ADR 011's "dedicated bot account: rejected" line becomes a partial reversal.** Future contributors reading 011 in isolation will see the rejection; they need to pick up 015 to see why the cost-benefit flipped. Mitigated by marking 011's relevant section "Superseded by 015 (PR + comment author identity)" in 011's `Status` line.

### Follow-on work

- **Provision the GitHub account.** Username `major-shell-bot` (or close match if taken), strong unique password, app-based 2FA enrolled on a credential the operator controls, recovery email pointed at an operator-owned address.
- **Generate fine-grained PAT.** Resource: `MioMarker/major`, `MioMarker/healthbite`, `MioMarker/healix`. Permissions per the Decision section. Expiration: 1 year (max). Store in 1Password under `major-shell-bot github PAT`.
- **Add as repo collaborator.** Write role on the three repos. Verify the bot can `git push` to a throwaway branch and `gh pr create` against `dev` before considering the setup done.
- **Update Shell env var.** `shell/.env` `GITHUB_TOKEN` swaps to the bot PAT. The example file (`shell/.env.example`) gains a comment "use the `major-shell-bot` PAT; not a user PAT."
- **Update Supabase function secrets.** `npx supabase secrets set GITHUB_TOKEN=<bot-pat>` against the dev project. Confirm `major-create-github-issue`, `major-import-external-issues`, `major-list-external-issues`, and `major-github-webhook` still function under the new token (they should — same scopes, just a different identity).
- **Update `docs/runbook.md` § token rotation.** Replace references to "the user PAT" with "the `major-shell-bot` PAT." Add the monthly check that the bot's PAT has not been revoked.
- **Update `.claude/rules/common/git-workflow.md`** to reflect that PR authorship is bot-mediated and the "joint review" rule operates with the human user as one valid approver.
- **Amend ADR 011's `Status` line** to read `Superseded by 015 (in part — PR + comment authorship)` and add a brief pointer at the top.
- **One-off cleanup script for the existing 33 PRs.** A throwaway shell script that admin-merges each in tier order. Not committed. Run once. Delete.
- **Add to `docs/failure-modes.md`** the entry "bot PAT leaked or revoked" with the rotation runbook for that specific account.

### Revisit conditions

- **The Shell becomes a GitHub App.** Installation tokens, fine-grained scoping per installation, and webhook-driven re-issuance replace the PAT model. Supersedes 015.
- **`dev` branch protection flips `require_code_owner_review` to `true`.** The bot is not a CODEOWNER; Mode 1 would stop working until the rule reverts or the bot is added to CODEOWNERS. The bot being a CODEOWNER would mean its absence-of-approval blocks merges, which is the wrong shape. Re-think the model if this flips.
- **Multi-tenant Major (more than one human user).** The 1-approval rule with the bot as author works for any human user. The PAT scope and CODEOWNERS membership might need to expand. Likely fine as-is, but the assumption "the user pressing Mode 1 is also a write-access collaborator on all three repos" needs to remain true.

## References

- `.claude/rules/common/git-workflow.md` — joint-review rule; needs amendment as part of follow-on.
- `.claude/rules/common/security.md` § Secret Management — bot PAT joins env-var-only secrets.
- `.claude/rules/shell/sandbox-discipline.md` § "`gh` and `git` Use Fine-Grained Tokens" — confirms the PAT model; the bot PAT is the next iteration.
- `shell/.env`, `shell/.env.example`, `shell/README.md` — env var documentation surface.
- ADR 007 — `Issues: Write` scope on the bot PAT continues the existing capability.
- ADR 011 — partially superseded by this ADR; outbound issue-resolution comments shift to the bot identity.
- `docs/runbook.md` § token rotation — monthly checklist target.
- `docs/failure-modes.md` § 14 — secret-rotation runbook, which gets a new bot-PAT-specific entry.
