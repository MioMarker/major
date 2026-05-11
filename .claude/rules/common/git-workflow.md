# Git Workflow

Trunk-based development on Major. Two devs (`@Pioneer18` and `@kuvekep14`) jointly own the repo. `dev` is the integration branch; `main` is the release branch (see `docs/adr/003-dev-as-integration-branch.md`).

## Branching

- **Always branch off `dev`.** No long-lived feature branches.
- Branch naming — short, descriptive, slash-separated:
  - `fix/issue-<N>-<slug>` — bug fix tied to an issue
  - `feat/<slug>` — new feature
  - `docs/<slug>` — docs-only
  - `refactor/<slug>` — code cleanup without behavior change
  - `hotfix/<slug>` — urgent prod fix
- For Major-driven Briefs, the Shell creates `major/brief-<id>` automatically. Don't author these branches by hand. (Pre-rename branches `major/work-item-<id>` stay for history.)
- Keep branches short-lived (hours to a few days).

## `dev` and `main` rulesets

Both branches are protected. The rulesets enforce:

- **No direct pushes.** `git push origin dev` (or `main`) from a feature branch is rejected.
- **Required PR with at least 1 approval.** The PR author cannot self-approve. Any non-author account with write access on the repo can satisfy the approval requirement.
- **Code-owner review is NOT required on `dev`.** The live `dev` ruleset has `require_code_owner_review = false`; only the 1-approval-from-a-non-author rule applies (confirmed via `gh api repos/MioMarker/major/rules/branches/dev` — see `docs/adr/015-major-shell-bot-identity.md`). `.github/CODEOWNERS` still lists both devs and is the conventional reviewer pool, but the merge gate is satisfied by any write-access reviewer.
- **Linear history.** Squash-merge or rebase-merge only. No merge commits.
- **No force push.** History is immutable on both branches.

Admins (the user) can bypass with `gh pr merge --admin` or "Merge without waiting for requirements" in the web UI. Agents must never bypass — leave merge to the user.

### Joint review with bot-authored PRs

PRs opened by the Shell are authored by `major-shell-bot`, a separate GitHub user account whose PAT the Shell carries (see `docs/adr/015-major-shell-bot-identity.md`). The bot is not a code-owner and is intentionally absent from `.github/CODEOWNERS`. Consequences for the joint-review rule:

- The PR author is the bot, not the human user. The human user is therefore a **valid approver** for any Shell-opened PR — they did not author it.
- Either human dev (`@Pioneer18` or `@kuvekep14`) can supply the 1 required approval on a bot-authored PR. The "eyes-on-merge" spirit of the joint-review rule is preserved: a human always approves before merge.
- The bot never approves PRs. It is an authoring identity only.
- `main`-targeting PRs (release `dev → main`) remain human-authored deliberate acts; the bot does not open them.

## PRs target `dev`, never `main`

Every Brief-driven PR opens against `dev`. Releases are explicit `release: dev → main` PRs, performed deliberately by a human, **not** by Major.

## Commits

- **Subject:** imperative mood, short (~60 chars). Example: `Add path-blocker glob editor to Settings`.
- **Body:** explain *why* and what the impact is, not a blow-by-blow diff.
- **Agent-assisted commits** get a co-author footer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Use HEREDOC for multi-line commit messages.

## Pull requests

- **Title:** same pattern as commit subject. If fixing an issue: `Fix #N: <slug>`.
- **Body:** describe what changed, why, what to verify, and any deploy notes.
- `Fixes #N` or `Closes #N` in the body auto-closes the issue on merge.
- Open as draft if work-in-progress; flip to ready-for-review when ready.
- Agents: do not merge PRs yourself — leave that to the user.
- **Shell-opened PRs are authored by `major-shell-bot`.** The Shell's `gh pr create` picks up the bot identity from its `GITHUB_TOKEN` env var. Human-authored PRs (manual work, release `dev → main`) still come from the dev's own account.

## Tag-based releases

Adopted from HealthBite's tag conventions.

| Pattern | Use | Example |
|---|---|---|
| `backend/YYYY-MM-DD` | Edge-function or migration deploy off `main` | `backend/2026-05-09` |
| `mobile/vX.Y.Z` | Mobile-app release (matches `app.config.ts` version) | `mobile/v2.4.0` |

Tags must be **annotated** (`git tag -a -m "..."`), never lightweight. The release tag points at the `main` commit produced by the `dev → main` merge.

```bash
git tag -a backend/2026-05-09 -m "Deploy: major-claim-brief v2 (issue #42)"
git push origin backend/2026-05-09
```

## Worktrees (for parallel agent work)

- Spawning multiple agents for parallel work: use `isolation: "worktree"` so each agent has its own checkout.
- Worktrees live in `.claude/worktrees/agent-<id>/` and are cleaned up by the agent framework.
- Leftover locked worktrees: `git worktree remove -f -f <path>` then delete the branches.

## Never

- Never bypass branch protection on `dev` or `main`. The rulesets exist for a reason.
- Never force-push to `dev` or `main`. Never delete either branch.
- Never commit secrets. Use env vars and Supabase secrets.
- Never skip the `Co-Authored-By` footer on agent-assisted commits.
- Never auto-merge a PR on behalf of the user.
- Never target `main` with a feature PR. Only the explicit `dev → main` release PR may merge to `main`.
