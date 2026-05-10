# NNN. First-class Skills primitive in the Cyberbrain

## Status

Deferred (grilled 2026-05-09; revisit conditions below)

Date: 2026-05-09

## Context

Major's Tachikomas operate from two static knowledge surfaces:

1. **Role prompts** (`shell/prompts/<role>.ts`) — versioned monolithic system prompts loaded at Tachikoma startup. Identical for every Brief in a given role. Edits require a `*_PROMPT_VERSION` bump (per `.claude/rules/shell/sandbox-discipline.md`) and a Shell image redeploy.
2. **Path-glob rules** (`.claude/rules/`) — auto-loaded by Claude Code when editing files matching the glob. Identical for every Brief. Edits go through the path-blocker (because `.claude/rules/**` is in the protected globs).

Neither surface is **per-Brief**, **description-driven**, or **dynamically discoverable** by the Tachikoma. There is no place to put domain knowledge whose relevance varies by Brief — for example:

- "How HealthBite's eval pipeline is structured" — relevant for `eval/**`-touching Briefs, irrelevant for everything else.
- "Healix's HIPAA logging conventions" — relevant for Briefs in that repo's PHI-touching code paths.
- "The shape of our Stripe webhook handler" — relevant for billing-area Briefs.

Today, including this knowledge means stuffing it into the role prompt (bloats every Tachikoma's context, regardless of need) or into a `.claude/rules/` glob (loaded only when the Tachikoma happens to edit a matching path, which is too late to inform planning). The result is that domain knowledge stays in human-curated docs that the Tachikoma may or may not read on its own.

Factory AI's Skills primitive solves the same problem. A Skill is a content-addressable, description-driven capability with a `description` field the model uses for self-selection at runtime. Skills can be marked `disable-model-invocation` (only the operator invokes), can be scoped per-project, and live as `.factory/skills/<name>/SKILL.md` with frontmatter.

Major's analog should live **in the Cyberbrain** rather than as files in a per-Tachikoma config directory. The Cyberbrain-as-source-of-truth invariant (root `CLAUDE.md` Hard Rule #1) requires that any state the lifecycle uses to make decisions lives in `major.*`. A Skill's relevance to a Brief is a lifecycle decision — the Shell decides which Skills to inject into a Tachikoma's startup context based on Brief metadata.

This ADR adds `major.skills` as a first-class Cyberbrain primitive.

### Alternatives considered

1. **Keep the status quo: prompts + path-glob rules.** Add domain knowledge by enlarging role prompts or adding `.claude/rules/` files. Rejected: prompt bloat is real (every Tachikoma loads every byte regardless of relevance); path-glob rules load too late to inform pre-edit reasoning; both require a Shell redeploy or path-blocker apply for every domain-knowledge edit.

2. **Add a `briefs.injected_context` text column.** Allow Triage Operations to write per-Brief context that the Shell injects into the Tachikoma startup prompt. Rejected: defeats reuse — the same domain knowledge gets written into many Briefs by hand; no description-based self-selection; Brief Content authority is restricted to text the Tachikoma sees during planning, conflating Brief Content (untrusted) with operator knowledge (trusted).

3. **Inject `.claude/rules/` files wholesale at Tachikoma startup.** Bypass Claude Code's path-glob loading and just load every rule file at startup. Rejected: bloats context for every Tachikoma; doesn't address the per-Brief relevance problem; Claude Code's glob-loading exists for a reason.

4. **`major.skills` table with description-based selection (chosen).** Skills as first-class Cyberbrain rows; Shell selects relevant Skills per Brief based on Brief metadata (target_paths, classification, project) and injects them into Tachikoma startup context. Description field is what the Tachikoma sees if and when it needs to self-select.

### Forces

- **Cyberbrain as source of truth.** Skill relevance is a lifecycle input; it lives in `major.*`, not in Tachikoma config files.
- **Reuse over per-Brief duplication.** A Skill written once is referenced from many Briefs.
- **Description-driven selection.** The Tachikoma either auto-loads a Skill (if its description matches the Brief metadata) or self-selects it from a manifest (if the Brief metadata is ambiguous).
- **Operator-only Skills.** Some Skills should not be model-invocable — they encode policy or process the Tachikoma must follow when an operator says so, but should not be triggered by the model deciding "this seems relevant." Mirrors Factory's `disable-model-invocation`. (Proposal 05 generalizes this for prompt sections.)
- **ADR-as-checkpoint stays.** Adding a Skill that affects the Tachikoma's policy stance is decision-class; new Skills land via ADR + migration. Adding a Skill that purely encodes domain knowledge (e.g., a description of an existing module) is implementation-class; lands via Triage Change Set with the new `create-skill` operation.
- **Versioning.** Skills are versioned the way prompts are. A Run records which Skill versions it loaded; replay needs to reconstruct the exact context.

## Decision

Add `major.skills` and the loader pathway from Brief metadata to Tachikoma startup context.

### Schema

```sql
CREATE TABLE major.skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                       -- short identifier, e.g. 'healthbite-eval-pipeline'
  description text NOT NULL,                -- one-line, model-readable
  body text NOT NULL,                       -- markdown content injected into Tachikoma context when selected
  scope text NOT NULL CHECK (scope IN ('org', 'project', 'brief')),
  scope_id text,                            -- NULL for org; project slug for project; brief id for brief
  selectors jsonb NOT NULL DEFAULT '{}',    -- relevance hints: { target_path_globs, classifications, repos }
  model_invocable boolean NOT NULL DEFAULT true,
  operator_invocable boolean NOT NULL DEFAULT true,
  version text NOT NULL,                    -- 'skillname@YYYY-MM-DD' — same convention as prompts
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'org' AND scope_id IS NULL) OR
    (scope IN ('project', 'brief') AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX skills_active_name
  ON major.skills(scope, COALESCE(scope_id, ''), name)
  WHERE superseded_at IS NULL;
```

### Selection rule (Shell-side)

When the Shell starts a Tachikoma for Brief `B`:

1. Resolve the active set of Skills in scope: org ∪ project[B.project] ∪ brief[B.id].
2. Auto-load the subset where `model_invocable = true` AND any `selectors` clause matches the Brief metadata. Selector matching:
   - `target_path_globs`: any `expected_path` on the Brief intersects any glob in the array.
   - `classifications`: Brief's classification matches.
   - `repos`: Brief's project matches.
3. The auto-loaded Skills' bodies are injected into the Tachikoma startup context, after the Instruction Trust Boundary opener and before role-specific instructions.
4. The remaining `model_invocable` Skills (those not auto-loaded) are exposed as a manifest the Tachikoma can request from a tool: `list_skills() → [{name, description}, …]`, then `load_skill(name) → body`. The Tachikoma decides whether to pull them based on description.
5. Skills with `model_invocable = false` are never auto-loaded and never appear in `list_skills`. They are loaded only when an explicit `briefs.operator_loaded_skills` array names them (set by a Triage Operation). This dovetails with proposal 05.

### Telemetry

Every Run records the exact set of Skills loaded (auto + on-demand) with versions. This is part of the Run's reproducibility envelope: `runs.loaded_skills jsonb` containing `[{name, version, mode: 'auto'|'on-demand'|'operator'}, …]`.

### Triage Operations for Skill management

Two new Triage Change Operations:

- `create-skill { name, description, body, scope, scope_id?, selectors, model_invocable, operator_invocable, version }` — creates a new Skill row.
- `supersede-skill { id, replacement_id }` — marks a Skill superseded; the replacement must have the same scope.

Both operations are subject to the path-blocker if the Skill scope is `org` or if the Skill body references protected paths (heuristic: body matches any glob in `path_blocker_rules.protected_globs`). This means Skill creation is auto-applied for project- and brief-scoped Skills with non-sensitive bodies; org-scoped or sensitive-body Skills require human apply.

### Scope of this ADR

In scope: table schema, selection rule, Triage operations, Telemetry shape.

Out of scope: a UI for browsing/editing Skills (separate follow-on); cross-org Skill federation; LLM-generated Skill bodies (must be human-authored or human-reviewed).

## Consequences

**Positive:**

- Domain knowledge gets a home that isn't a 2000-line role prompt or a 30-file `.claude/rules/` directory.
- Per-Brief relevance: a Brief touching `eval/**` gets the eval-pipeline Skill auto-loaded; a Brief touching the UI gets nothing eval-related.
- Reuse: one Skill, many Briefs.
- Versioned and reproducible: every Run records which Skill versions it saw.
- Operator-only Skills give a place for policy-adjacent process knowledge (e.g., "what to do when the QA Confirmation step blocks") without exposing it to model self-selection.
- Cyberbrain-as-truth invariant preserved.

**Negative:**

- **Selection-rule drift.** If selectors don't match a Brief's metadata, a relevant Skill won't auto-load. The on-demand manifest mitigates this; the Tachikoma can ask. But on-demand discovery depends on the Skill's description being clear, and that's an authoring problem.
- **Schema cost.** A new table + new event types + new Triage operations. Not free.
- **Body bloat in context.** Auto-loading too many Skills bloats Tachikoma context. Mitigated by tight selectors and a soft cap (max 5 auto-loaded Skills per Run; if more match, log a Telemetry warning).
- **Authoring discipline.** Skills are only useful if their bodies are clear, scoped, and self-contained. Bad Skills (vague, sprawling) make Tachikomas worse, not better.
- **Adjacent to prompts.** The boundary between a "prompt section" and a "Skill" is fuzzy. Proposal 05 (operator-invocable prompt sections) addresses the prompt side; this ADR addresses the Skill side; the two need to coexist without redundancy. Recommended boundary: role prompts encode *how to behave in a role*; Skills encode *what to know about the codebase or a process*.
- **Operator-invocable Skills could become hidden control surfaces.** A poorly-named operator-only Skill might effectively be policy that's not visible from the role prompt. Mitigated by ADR-required ratification of any Skill whose body changes Tachikoma policy stance.

**Follow-on work:**

- Update `SPEC.md` to add a "Skills" subsection alongside primitives.
- Update `docs/CONTEXT.md` glossary to define Skill, Skill scope, and the model-invocable / operator-invocable distinction.
- Update `.claude/rules/shell/sandbox-discipline.md` to require the Tachikoma startup pipeline to inject the Instruction Trust Boundary *before* any Skill body, not after.
- UI: a Skills browser at `Settings → Skills` showing scope, version, and where each is referenced.
- Telemetry: monthly review of which Skills auto-loaded vs. on-demand-loaded vs. never loaded. Skills that never load are dead weight.
- **Revisit conditions:**
  - When the Skill count grows past a soft threshold (e.g., 30) and selection complexity becomes a real cost. Consider hierarchical Skill taxonomies.
  - When a Skill body is found to have leaked a secret (rotation per `docs/failure-modes.md` § 14, then a process review).
  - When the prompt-section boundary (proposal 05) collides with a Skill's body — refactor the prompt or the Skill, do not duplicate.

## Verdict (2026-05-09)

Deferred. The Skills-as-Cyberbrain-table shape is more machinery than today's prompts and `.claude/rules/` patterns warrant; v1's role prompts are the right size, and per-Brief domain knowledge is rare enough to live as path-glob rules without hurting Tachikomas.

Revisit conditions:

- A role prompt grows past ~600 lines because it has accreted repo-specific knowledge that a Skills surface would carry better.
- Domain knowledge is duplicated verbatim across HealthBite's and Healix's `.claude/rules/` and reuse is the cheaper fix.
- A Run fails for lack of context that no current surface (role prompt, path-glob rules, Brief Content) could plausibly provide.
- Auto Triage Run becomes a meaningful Brief intake path; operator-only Skills (the `model_invocable=false` shape) get more value when an automated triage stage exists to invoke them.

Cheaper alternative when revisiting: prefer file-based Skills (`shell/skills/<name>.md` with frontmatter) over a Cyberbrain table, unless a non-engineer authoring need or a genuine runtime-editable use case has materialized. The table is the right shape only if Skills are mutable from the operator UI; otherwise, files are simpler.
