# NNN. Hierarchical, non-weakening policy scope for path-blocker config

## Status

Deferred (grilled 2026-05-09; revisit conditions below)

Date: 2026-05-09

## Context

The path-blocker (`docs/adr/002-path-blocker-rule.md`) is Major's primary deterministic gate on which Triage Change Sets auto-apply versus require human apply. It reads from a single `path_blocker_config` row holding `protected_globs` and `mass_rerank_threshold`. The rule is flat: there is one config; it applies to every Brief, in every dependent repo, against every Triage Change Set.

This was the right shape for v1, when Major drives two repos (HealthBite, Healix) on behalf of two devs. It is not the right shape past that point. Three concrete pressures push toward a hierarchy:

1. **Multi-repo divergence.** Healix's `eval/**` boundary may differ from HealthBite's. Today both are protected by the same glob list because the list happens to fit both. As soon as a third dependent repo enters scope, the glob list becomes a union that is correct for none of them.

2. **Org-level invariants vs. project ergonomics.** Some path-blocker entries (`supabase/migrations/**`, `.claude/rules/**`) reflect cross-repo invariants — never auto-apply, anywhere. Others (`app.config.ts`) are project-specific. Conflating them in one list means a project-specific tweak risks weakening a cross-cutting invariant.

3. **Future Brief-scoped overrides.** A high-risk Brief may need to *narrow* the auto-apply surface even further (e.g., a Brief migrating away from `chat-with-ai` deliberately wants the entire `supabase/functions/**` tree treated as protected for the duration of that Brief). Today there is no path to express that without editing the global config.

Factory AI's enterprise model handles this with hierarchical settings: org > project > user, where **lower scopes can only narrow, never widen** what the parent allows. The non-weakening guarantee is the load-bearing piece. Without it, hierarchical config becomes a way to *bypass* org rules, not enforce them.

This ADR adopts the same hierarchy for path-blocker config and adds the non-weakening guarantee as a CHECK constraint at write time.

### Alternatives considered

1. **Keep flat config, deploy multiple Major instances.** Run a separate Major per dependent repo; each has its own flat path-blocker config. Rejected: defeats the orchestrator premise (one Major coordinates many repos), forces operational duplication, doesn't address Brief-scoped overrides.

2. **Per-Brief overrides only (no project tier).** Allow a Brief to override the global config but skip the project layer. Rejected: per-Brief overrides without an enforced narrowing rule lets a single Brief weaken the global config; without the project tier, the cross-repo-vs-per-repo distinction has no place to live.

3. **Hierarchical scope with enforced narrowing (chosen).** Three tiers — org, project, brief. Effective config = intersection of in-scope rules. Lower scope can only add globs (more protection), never remove them.

4. **LLM-evaluated risk per Change Set.** Reject every static-config approach in favor of an LLM judging each Change Set. Rejected for the same reasons as in ADR 002 — non-deterministic, unauditable, susceptible to prompt-injection from Brief Content.

### Forces

- **Non-weakening must be a structural guarantee**, not a code-review convention. If a project-tier row can widen the auto-apply surface beyond what the org tier permits, the hierarchy is an attack surface, not a control.
- **Determinism preserved.** Effective config must still be a pure function of the in-scope rows. Same Change Set + same rule set = same decision.
- **Auditability.** Each path-blocker firing must record *which tier's globs matched*, so postmortems can distinguish "org rule fired" from "project rule fired" from "brief rule fired."
- **Backward compatibility.** Existing path-blocker config row must continue to work. The migration seeds the existing row as the org-tier config and is a no-op behaviorally.
- **No new authority.** This ADR does not give anyone new powers; it organizes the existing power across tiers and enforces narrowing.

## Decision

Major adopts a three-tier hierarchical path-blocker config with structural non-weakening.

### Schema

Replace the singleton `path_blocker_config` row with `major.path_blocker_rules`:

```sql
CREATE TABLE major.path_blocker_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('org', 'project', 'brief')),
  scope_id text,  -- NULL for org; project slug for project; brief id for brief
  protected_globs text[] NOT NULL,
  mass_rerank_threshold integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  superseded_at timestamptz,  -- append-only; current effective row is the most recent un-superseded row per (scope, scope_id)
  CHECK (
    (scope = 'org' AND scope_id IS NULL) OR
    (scope IN ('project', 'brief') AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX path_blocker_rules_active
  ON major.path_blocker_rules(scope, COALESCE(scope_id, ''))
  WHERE superseded_at IS NULL;
```

### Effective rule resolution

For a given Triage Change Set targeting Brief `B` in project `P`:

```
effective.protected_globs       = org.protected_globs
                                ∪ (project[P]?.protected_globs ?? ∅)
                                ∪ (brief[B]?.protected_globs ?? ∅)
effective.mass_rerank_threshold = min(org, project[P], brief[B])
```

Union for globs, min for threshold. Both monotonic toward *more* protection.

### Non-weakening enforcement

A `BEFORE INSERT` trigger on `major.path_blocker_rules` rejects any insert where:

- `scope = 'project'` and `protected_globs` does not contain every glob in the active org row, OR
- `scope = 'brief'` and `protected_globs` does not contain every glob in the active org and project rows, OR
- `mass_rerank_threshold` exceeds the parent tier's threshold.

The trigger function lives in the same migration as the table. It is the structural guarantee — code paths that bypass the trigger are bugs.

### API surface

- `major-update-path-blocker-rule`: edge function, service-role only. Validates scope, computes the effective tier, inserts the new row, supersedes the old row in one transaction with an idempotency key derived per `SPEC.md`.
- `major-apply-change-set` reads the resolved effective rule before invoking the path-blocker check. The `apply_decision` field on the Change Set is extended to record `matched_tier: 'org' | 'project' | 'brief' | null` alongside `matched_glob`.

### Scope of this ADR

In scope: schema, resolution rule, non-weakening enforcement, edge-function surface.

Out of scope: UI for editing rules per tier (separate follow-on); cross-org federation (Major is single-org by construction in v1).

## Consequences

**Positive:**

- Multi-repo invariants survive when project-tier configs differ. The org tier carries cross-cutting truths (`supabase/migrations/**`, `.claude/rules/**`); the project tier carries local truths (`app.config.ts`).
- Non-weakening is structurally enforced. A project-tier or brief-tier row that tries to remove an org-tier glob is rejected at the database; no code path can bypass.
- Per-Brief narrowing becomes possible. A Brief tagged `migration` or `eval-touching` can have a brief-tier row that protects more aggressively for the duration of that Brief.
- Audit trail is more useful. `apply_decision` now distinguishes "org rule fired" from "project rule fired"; postmortems and glob-list refinements get pointed feedback.
- Effective rule is still a deterministic pure function — same inputs, same decision.

**Negative:**

- More config surface. Three tiers means three places to look when debugging a path-blocker firing. Mitigated by always recording `matched_tier` on every firing.
- Resolution cost. Each apply now reads up to three rows instead of one. The cost is a single indexed query — measured in microseconds — but it is non-zero.
- Migration complexity. The seed migration must move the existing row into the org tier without changing observable behavior. Tested by replaying the last month of Triage Change Sets through both rule sets and asserting equal decisions.
- Friction adding a project. Onboarding a third dependent repo now requires writing a project-tier row. Acceptable; the row is small and the alternative is an over-broad org-tier list.

**Follow-on work:**

- UI editor under `Settings → Path-Blocker` with three tabs (Org / Project / Brief). Show the effective resolved rule alongside each tier.
- Telemetry: count path-blocker firings per tier per week. If org-tier never fires, the org tier is dead weight; if brief-tier fires often, that's a signal to lift the pattern up to project tier.
- Update `SPEC.md` § *Path-Blocker* to reference this ADR and document the three-tier resolution.
- Update `.claude/rules/db/migrations.md` to note that path-blocker rule changes require an ADR (already required) and now also a migration (no longer just a config edit).
- **Revisit conditions:**
  - When a fourth tier becomes plausible (per-environment, per-runner). Don't add it preemptively.
  - When a non-weakening trigger violation occurs in the wild. Postmortem may need to harden the trigger or add a CI lint that catches violations earlier.
  - When the dev team grows past two and a true org admin / project admin role split emerges. The current trigger has no admin distinction; it would need one.

## Verdict (2026-05-09)

Deferred. The three-tier hierarchy is the right shape eventually, but it is premature at two repos and two devs. The current flat `path_blocker_config` row is correct for v1 because there is genuinely one config that fits both dependent repos.

Revisit conditions:

- A third dependent repo enters scope, AND the org-tier glob list has become a union that is wrong for at least one of them.
- Per-Brief narrowing becomes a concrete need (a specific Brief wants to protect more than the global config protects, for the duration of the Brief).
- The non-weakening guarantee becomes a real concern because some glob is being weakened by accident under the flat shape.

Cheaper alternative when revisiting: ship the `repo` column reshape on `path_blocker_config` (one row per repo, no hierarchy) before reaching for three tiers. Three tiers buys non-weakening; per-repo rows buy multi-repo divergence. They are different problems and the per-repo split solves the more likely first one.
