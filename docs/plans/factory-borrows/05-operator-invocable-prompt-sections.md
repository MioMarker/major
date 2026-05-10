# NNN. Operator-invocable prompt sections in Tachikoma role prompts

## Status

Deferred (grilled 2026-05-09; revisit conditions below)

Date: 2026-05-09

## Context

Tachikoma role prompts (`shell/prompts/<role>.ts`) are monolithic. Each role's prompt is a single string, loaded in full at Tachikoma startup, identical for every Brief that runs through that role. Edits require a `*_PROMPT_VERSION` bump and a Shell image redeploy (per `.claude/rules/shell/sandbox-discipline.md`).

This shape works for *role behavior* — how the implementer plans, when the reviewer approves, what verification the planner expects. It does not work cleanly for two adjacent kinds of content that have started showing up in the prompts:

1. **Knowledge that is large but only sometimes relevant** — module-specific conventions, codebase-specific gotchas, examples of past-acceptable PRs. Including all of it bloats the system prompt for every Run regardless of need.
2. **Process knowledge that is operator-controlled** — instructions like "if the path-blocker fires, do X first" or "when running against the eval-pipeline area, follow the specific sequence in §X." These are guidance the operator wants the Tachikoma to receive *only when the operator has decided this Run needs them*, not whenever the model self-selects.

Proposal 03 (Skills primitive) addresses (1) — content moves to `major.skills`, selected per-Brief by selectors and description. This proposal addresses (2): a way to mark sections of the role prompt as **operator-invocable only** — loaded only when an explicit Triage Operation has tagged the Brief.

The model is borrowed from Factory AI's `disable-model-invocation` flag on Skills. Factory uses it to prevent the model from self-selecting a capability whose use should be the operator's decision. Major's analog is sharper: the role prompt itself can have sections that don't load unless the operator explicitly turns them on for a specific Brief.

The boundary between this and proposal 03:

- **Skills (proposal 03)** are *what to know* — codebase domain knowledge, module shapes, integration conventions. Per-Brief selection by metadata.
- **Operator-invocable prompt sections (this proposal)** are *what to do under specific operator-decided circumstances* — process variations, escalation procedures, repair-mode instructions. Per-Brief selection by Triage Operation.

If a piece of content is "the Tachikoma should know this when working in `eval/**`," it is a Skill. If a piece of content is "the Tachikoma should follow this procedure when the operator has decided this Run is in repair mode," it is an operator-invocable prompt section.

### Alternatives considered

1. **Keep monolithic role prompts.** Stuff everything into the role prompt and rely on the model to ignore irrelevant sections. Rejected: prompt bloat is real; relevant guidance gets diluted; the Instruction Trust Boundary opener is followed by sections that contradict each other in their applicability.

2. **Per-Brief prompt overrides via Triage Change Set.** Allow a Triage Operation to write a per-Brief prompt suffix. Rejected: every Brief becomes a unique prompt, which destroys the prompt-versioning discipline (`.claude/rules/shell/sandbox-discipline.md`); operators end up authoring ad-hoc prompts under deadline pressure; no reuse.

3. **Push everything to Skills (proposal 03).** Treat process knowledge as just another Skill with `model_invocable = false`. Rejected: process variations are *role-specific* (the implementer's repair-mode procedure is different from the reviewer's). Encoding role-specific process knowledge as Skills detached from the role conflates two different concerns and makes role-prompt evolution harder.

4. **Two-tier sections in the role prompt with explicit operator-only loader (chosen).** Sections within `shell/prompts/<role>/` are tagged model-invocable (default, always loaded) or operator-invocable (loaded only when a Triage Operation has named the section on the Brief). The role prompt remains the home for role-specific guidance; the loader respects the tag.

### Forces

- **Role-specific stays with the role.** Process variations specific to a role belong in the role's prompt directory, not in a generic Skills table.
- **Operator-controlled section selection.** Sections only load when a Triage Operation has explicitly tagged the Brief. The model cannot self-select an operator-invocable section.
- **Versioning preserved.** Each section has its own `*_PROMPT_VERSION` constant. Editing an operator-invocable section bumps the section's version, not the whole role's.
- **Audit trail.** Every Run records which sections (model-invocable + operator-invocable) loaded, with versions. Combined with proposal 04's stream-json telemetry, the loaded section set is part of the Run's reproducibility envelope.
- **Boundary discipline with proposal 03.** If a section's content is "what to know," migrate it to a Skill. If a section's content is "what to do when operator says so," it stays a section. The two ADRs explicitly cite each other to make the boundary maintainable.

## Decision

Tachikoma role prompts are split into named sections under `shell/prompts/<role>/`. Each section has frontmatter declaring whether it is model-invocable or operator-invocable. The Shell's prompt loader assembles role prompts from sections, respecting the tag and the Brief's `operator_loaded_sections` array.

### File layout

```
shell/prompts/
├── versions.ts                     # *_PROMPT_VERSION constants (existing)
├── implementer/
│   ├── 00-instruction-trust-boundary.md   # always first; never operator-invocable
│   ├── 10-role-overview.md
│   ├── 20-planning.md
│   ├── 30-tool-use.md
│   ├── 90-repair-mode.md           # operator-invocable
│   └── _section.ts                 # exports the assembled role prompt
├── reviewer/
│   └── …
└── …
```

Sections are markdown files with TOML frontmatter:

```markdown
---
name: repair-mode
version: implementer-repair-mode@2026-05-09
model_invocable: false
operator_invocable: true
description: Procedure for repair-mode Runs after a verification failure.
---

When this Run is in repair mode...
```

Sections without frontmatter default to `model_invocable: true`, `operator_invocable: true`. The Instruction Trust Boundary section (`00-instruction-trust-boundary.md`) is hardcoded to load first regardless of tags; that's a Hard Rule (`.claude/rules/shell/sandbox-discipline.md`).

### Loader behavior

In `shell/prompts/<role>/_section.ts`, the assembled prompt for Brief `B`:

1. Start with the Instruction Trust Boundary section.
2. Add every section where `model_invocable = true`, in lexical filename order.
3. Add every section where `operator_invocable = true` AND the section's `name` is in `briefs.operator_loaded_sections`.
4. Concatenate with double-newline separators.
5. Record the loaded set on the Run: `runs.loaded_prompt_sections jsonb` containing `[{name, version, mode: 'always' | 'operator'}, …]`.

### Triage operation

A new Triage Change Operation:

```
load-prompt-section { brief_id, role, section_name }
```

Adds `(role, section_name)` to `briefs.operator_loaded_sections`. The operation is gated by the path-blocker the same way other operations are: if the section's `name` is in a future "sensitive sections" list, the operation requires human apply.

### Schema

```sql
ALTER TABLE major.briefs
  ADD COLUMN operator_loaded_sections jsonb NOT NULL DEFAULT '[]';
  -- shape: [{role: 'implementer', section: 'repair-mode'}, …]

ALTER TABLE major.runs
  ADD COLUMN loaded_prompt_sections jsonb NOT NULL DEFAULT '[]';
  -- shape: [{name, version, mode}, …]
```

### Versioning rule

Editing a section bumps that section's `version` field in its frontmatter to today's date in `<role-section>@YYYY-MM-DD` format. The role's overall `*_PROMPT_VERSION` constant in `versions.ts` is replaced by a derived signature: `<role>@hash-of-active-section-versions`, which is what gets logged on every Tachikoma call.

This means a section edit produces an automatic role-version change without manually editing `versions.ts`. The same convention as before, just computed from sections.

### Scope of this ADR

In scope: section file format, loader behavior, Triage operation, schema additions, versioning rule.

Out of scope: a UI for browsing sections (likely lives under the Skills browser in proposal 03's follow-on); LLM-assisted authoring of operator-invocable sections (operators write these; LLMs do not); migration tooling for splitting existing monolithic role prompts (do this incrementally, role-by-role, as Briefs reveal which sections want operator gating).

## Consequences

**Positive:**

- Operator gets a clean handle to inject role-specific guidance without rewriting the prompt or polluting every Run.
- Role prompts can grow without bloating the always-loaded context.
- Versioning gets finer-grained: a repair-mode-section edit doesn't churn the implementer prompt's hash for unrelated Runs.
- Audit trail is sharper. `runs.loaded_prompt_sections` plus `runs.loaded_skills` (proposal 03) give a complete picture of what the Tachikoma saw.
- Boundary with Skills is explicit and maintainable.
- The Instruction Trust Boundary opener is structurally first; the file layout enforces it (`00-` prefix), and the loader hardcodes it.

**Negative:**

- **Authoring friction.** Splitting a role prompt into sections is a one-time cost; thereafter editing requires choosing the right section. Mitigated by clear section-naming conventions.
- **Loader complexity.** The Shell now assembles prompts at startup from filesystem reads. The cost is sub-millisecond; the risk is a buggy loader. Mitigated by tests on the assembled output for known section sets.
- **Section-version explosion.** Each section's version date drifts independently. The derived role-version hash captures the truth, but operators reading logs see hash strings instead of human-readable dates. Mitigated by the audit-trail field showing per-section versions in `runs.loaded_prompt_sections`.
- **Risk of overuse.** Operators may start gating too much content as operator-invocable, leading to Runs whose effective prompt depends heavily on Brief-specific tagging. The default should remain that most sections are model-invocable; operator-invocable is for genuinely operator-controlled procedure.
- **Conflict surface with proposal 03.** A new piece of content could plausibly land as either a Skill or a section. Without discipline the two surfaces grow redundantly. Mitigated by explicit cross-citation in this ADR and proposal 03, and by review at PR time.

**Follow-on work:**

- Update `SPEC.md` to document the section-based prompt assembly and the derived role-version-hash shape.
- Update `.claude/rules/shell/sandbox-discipline.md` § "Prompt Versioning" to reflect the new computed hash convention.
- Migrate existing role prompts to section files in one PR per role, with no behavior change (assembled prompt textually equal to the prior monolithic prompt).
- UI surface listing operator-loaded sections per Brief; allow toggling via the Triage UI, recorded as a `load-prompt-section` Triage Operation (with apply gated by path-blocker).
- **Revisit conditions:**
  - When section count grows past ~10 per role and assembly latency or operator confusion becomes a real cost.
  - When a Run shows that an operator-invocable section was *implicitly* loaded (a loader bug). The hardcoded "Instruction Trust Boundary first" check is non-negotiable; any deviation is a critical bug.
  - When proposal 03 (Skills) and this proposal collide on a piece of content. Refactor to one home; do not duplicate.

## Verdict (2026-05-09)

Deferred. The role prompts today are monolithic but small; the section/loader machinery is heavier than the problem warrants. There is exactly one concrete operator-controlled-procedure use case (repair mode) and it is cheaply addressable without a section system.

Revisit conditions:

- A role prompt grows past ~600 lines because it has accreted genuinely role-shape content that wants section gating.
- A second concrete operator-controlled-procedure use case appears beyond repair mode.
- Proposal 03 is reconsidered and the boundary between "what to know" (Skill) and "what to do under operator-decided circumstances" (section) needs drawing for real.

Cheaper alternative when revisiting: if repair-mode wiring is wanted soon, ship it via a dynamic prompt suffix keyed off `runs.purpose='repair'` (no schema change, no loader, no frontmatter). The section system buys generality; the suffix-by-purpose approach buys the one concrete case at a fraction of the cost.
