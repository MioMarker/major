# 003. `dev` is the integration branch; `main` is the release branch

## Status

Accepted

Date: 2026-05-09

## Context

HealthBite today is trunk-based with `main` as the integration branch. Branches off `main`, PRs back to `main`, releases (mobile EAS builds, edge function deploys) are tagged on `main`. This works fine for a single-team, single-codebase rhythm, but it conflates "merged" with "released" and makes deliberate release moments awkward.

Healix already operates with `dev` as the integration branch and `main` as the release branch — Healix's web deploy pipeline pushes from `main` only. The difference between the two repos creates friction every time someone context-switches.

Major is being built to drive both repos. Its lifecycle assumes Items merge to a stable integration branch (`dev`-style) and are released to production through an explicit, deliberate `dev → main` merge. The Item lifecycle in `SPEC.md` already names `base_branch=dev` for the v1 Git Branch convention (`major/work-item-<id>` off `dev`).

This ADR records the decision to switch HealthBite to dev-as-integration so:

- HealthBite and Healix share the same workflow vocabulary.
- Major's `git_repository_ref` config is uniform across the two repos.
- Releases become deliberate `dev → main` merges, decoupling "merged" from "released."

### Alternatives considered

1. **Keep `main` as integration on HealthBite.** Rejected: makes release tagging awkward (the integration branch is also the release branch, so every merge is implicitly a release candidate); diverges from Healix; forces Major to special-case HealthBite's `base_branch`.
2. **Use a feature-branch staging convention** (no `dev` branch; instead a long-lived `release-candidate` branch). Rejected: too informal; relies on humans remembering which branch carries which meaning; doesn't generalize.
3. **Switch HealthBite to dev-as-integration (chosen).** Aligns with Healix; matches Major's assumed model; decouples merge from release.

### Forces

- **Cross-repo consistency.** Devs context-switch between HealthBite and Healix daily. Two different integration models is friction with no upside.
- **Deliberate releases.** Mobile releases and edge-function deploys are real events worth a separate merge. Conflating "PR merged" with "shipped" historically led to surprise releases.
- **Major's lifecycle already assumes it.** `SPEC.md` names `dev` as the Item base branch. Adopting it on HealthBite is required for Major to drive HealthBite Items consistently.
- **Branch protection cost.** A new long-lived branch needs the same ruleset as `main`. This is mechanical, not architectural.

## Decision

HealthBite adopts `dev` as the integration branch and `main` as the release branch, matching Healix.

### Concretely

- All PRs (human-authored and Major-driven) target `dev`. `main` no longer accepts merges from feature branches.
- Releases happen via a dedicated `release: dev → main` PR. The PR is reviewed (code-owners), merged (squash or rebase), then tagged (`backend/YYYY-MM-DD` or `mobile/vX.Y.Z`).
- EAS builds and `supabase functions deploy` reference `main` as the release source.
- Branch protection rulesets apply to both `dev` and `main`: required PR, required code-owner review, no direct push, no force-push, linear history.

### Major's view

- `major.work_items.base_branch` defaults to `dev`. This is correct under the new model.
- Major opens PRs via `gh pr create --base dev --head major/work-item-<id>`. No code change required — this matches the v1 design.

## Consequences

**Positive:**
- HealthBite and Healix share the same integration/release model. One mental model, two repos.
- Releases become deliberate. The `dev → main` merge is a moment a human consciously chooses, not a side effect of merging a feature.
- Major's `git_repository_ref` config is uniform across repos.
- Tags become meaningful again: `backend/2026-05-09` is a real release moment, not a "moment we noticed and tagged."

**Negative:**
- **Branch protection ruleset duplication.** The `main` ruleset must be mirrored on `dev`. Mechanical but not free; a small drift risk between the two rulesets exists.
- **CODEOWNERS retargeting.** The existing CODEOWNERS file works for any target branch, but documentation that names "PRs to `main`" must be updated.
- **Muscle memory rebuild.** Both devs (`@Pioneer18`, `@kuvekep14`) currently target `main`; they need to retrain to target `dev`. PR-target review during the first week catches mistakes.
- **Existing HealthBite docs need updating.** `.claude/rules/common/git-workflow.md` and `.claude/rules/common/deploy-workflow.md` both reference `main` as integration. Updating them is **out of scope for this ADR's commit** — handled by a follow-on PR in the HealthBite repo (see Follow-on work).

**Follow-on work:**
- File issue: `Update healthbite/.claude/rules/common/git-workflow.md and deploy-workflow.md for dev-as-integration`. Owner: whichever dev runs the cutover.
- File issue: `Update Healix's deploy pipeline doc to align release semantics with HealthBite`. Even though Healix already uses dev-as-integration, the docs may need wording alignment.
- Add a `dev` ruleset on the HealthBite repo mirroring the existing `main` ruleset; verify with a no-op PR.
- After cutover, retire any HealthBite scripts that explicitly reference `main` as a target (none currently known; spot-check during the cutover).
- **Revisit conditions:**
  - If we ever need a release-candidate branch separate from `main` (e.g., for a hotfix workflow), open a new ADR.
  - If the `dev → main` cadence becomes pure ceremony (every merge to `dev` immediately gets a release PR with no batching), reconsider whether the two-branch model is still earning its complexity.
