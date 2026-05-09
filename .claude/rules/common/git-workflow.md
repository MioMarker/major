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
- For Major-driven Items, the Runner Instance creates `major/work-item-<id>` automatically. Don't author these branches by hand.
- Keep branches short-lived (hours to a few days).

## `dev` and `main` rulesets

Both branches are protected. The rulesets enforce:

- **No direct pushes.** `git push origin dev` (or `main`) from a feature branch is rejected.
- **Required code-owner review.** The PR author cannot self-approve. `.github/CODEOWNERS` lists both devs as joint owners; the other dev must approve.
- **Linear history.** Squash-merge or rebase-merge only. No merge commits.
- **No force push.** History is immutable on both branches.

Admins (the user) can bypass with `gh pr merge --admin` or "Merge without waiting for requirements" in the web UI. Agents must never bypass — leave merge to the user.

## PRs target `dev`, never `main`

Every Item-driven PR opens against `dev`. Releases are explicit `release: dev → main` PRs, performed deliberately by a human, **not** by Major.

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

## Tag-based releases

Adopted from HealthBite's tag conventions.

| Pattern | Use | Example |
|---|---|---|
| `backend/YYYY-MM-DD` | Edge-function or migration deploy off `main` | `backend/2026-05-09` |
| `mobile/vX.Y.Z` | Mobile-app release (matches `app.config.ts` version) | `mobile/v2.4.0` |

Tags must be **annotated** (`git tag -a -m "..."`), never lightweight. The release tag points at the `main` commit produced by the `dev → main` merge.

```bash
git tag -a backend/2026-05-09 -m "Deploy: major-claim-item v2 (issue #42)"
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
