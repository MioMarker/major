# 013. Planner output contract: Markdown plan file at `/work/.major/plan.md`

## Status

`Proposed`

Date: 2026-05-10

## Context

The intake-and-stubs plan (`docs/plans/intake-and-stubs/00-briefing.md`) Phase 1 promotes the Planner Tachikoma from stub to a first-class Phase 0 in the Shell pipeline (`runPlanner → runImplementer → runReviewer`). Two related decisions are policy questions answered directly: the gate (Planner runs only on `epic` / `parent` / multi-`expected_paths` Briefs) and verification stance (advisory in v1). The third — **what shape does Planner output take, and how does Implementer consume it?** — is decision-class. The current `shell/prompts/planner.md` stub is silent on this beyond a "skeleton when wired" sketch and a JSON envelope on stdout's last line; nothing in the codebase yet treats a plan as a durable primitive.

The choice cuts across primitive boundaries (Brief Artifact vs ephemeral sandbox state vs Run telemetry), affects schema (whether `artifact_type_contracts` gains a `plan` row), and shapes how future phases (Repair, the Phase 2 work) can consume planner output. A future contributor reading the wired Planner code without this ADR would reasonably re-litigate it.

### What Implementer needs from the Plan

The Implementer prompt is the primary consumer. It needs the Plan as **context loaded ahead of its first turn** — the file list to edit, the change order, the verification strategy, the flagged risks. Implementer is a Tachikoma, so "context" means tokens in the prompt or files reachable from `/work`. A few candidate consumers further out:

- **Reviewer Tachikoma** — could compare diff to plan ("you said you'd touch X, didn't") if the plan is structured.
- **Repair Tachikoma** (Phase 2) — could read the original plan to understand intent before re-attempting work.
- **Humans** — when a Brief parks at `ready-for-human`, reading the plan helps diagnose whether the failure was in planning or execution.

For v1, only Implementer is a confirmed consumer. Reviewer and Repair coupling is speculative.

### Where the Plan can live

The candidate locations and their primitive boundaries:

| Location | Primitive | Lifetime | Read by |
|---|---|---|---|
| `/work/.major/plan.md` (sandbox file) | None — ephemeral sandbox state | Wiped per `shell/main.ts` between Briefs (sandbox-discipline rule) | Anything in the same sandbox session |
| `runs.final_text` (Run row) | Run summary metric (ADR 006) | Lifetime of the Run row | SQL only; no UI today |
| `major.brief_artifacts` (new artifact type `plan`) | First-class Brief Artifact | Lifetime of the Brief | Anything that joins on `brief_id` |
| `major.telemetry_records` (per-event) | Non-lifecycle observation (ADRs 005, 006) | Lifetime; subject to future retention ADR | Postmortems, dashboards |

The Cyberbrain authority axiom (`SPEC.md` §Philosophy) says the Cyberbrain is authoritative for **lifecycle state**. The Plan is not lifecycle state — it is input to the next phase, not output for review or QA. Lifecycle code does not branch on plan content. That observation pulls toward sandbox-only or Run-row durability, not a new Brief Artifact.

### Alternatives considered

1. **Markdown plan file at `/work/.major/plan.md` (chosen).** Planner Tachikoma writes a Markdown plan to a known sandbox path; Implementer prompt prepends it as a "PLAN" section by reading the file at startup. Plan is durably observable post-hoc through `runs.final_text` (the Planner Run's final assistant message is the plan, captured by the existing ADR 006 stream-json telemetry path). No schema change; no new artifact-type contract. The smallest surface that meets v1 needs.

2. **Structured JSON step list as a new Brief Artifact (`plan` artifact type).** Plan is `List<{step, intent, files, verify}>`, stored as `major.brief_artifacts.body_json` under a new `plan` artifact type contract. Implementer reads steps in order. Pros: structured, queryable, durable beyond the sandbox, surfaces cleanly in Brief Detail. Cons: a new `artifact_type_contracts` row (claim/produce/review/verify/accept rules — most of which don't apply for an intermediate phase output), schema migration, and a UI surface to render it. Heavier than v1 needs, given Implementer is the only confirmed consumer.

3. **Both — Markdown body + JSON sidecar.** Plan stored as Brief Artifact with a Markdown body and a small JSON sidecar (step count, predicted file list). Most flexible, also the most surface area: combines the costs of (2) with the redundancy of two representations. Rejected for v1.

4. **No file — plan lives only in `runs.final_text`; Implementer prompt reaches into the Cyberbrain to fetch it.** The Tachikoma would have to call a Major API from inside the sandbox to read a sibling Run's row, which violates the boundary that Tachikomas reach the Cyberbrain only via prompt context written by the Shell. Rejected.

5. **Plan emitted only as stream-json telemetry; no consolidated artifact.** Per-event telemetry already exists (ADR 006). But the Tachikoma's stream-json events are a turn-by-turn transcript, not a consolidated plan; reconstructing "the plan" from telemetry would require parsing assistant text out of events and is the wrong shape for Implementer to consume. Rejected.

### Forces

- **Planner population is small in v1.** The gate (`epic` / `parent` / multi-`expected_paths`) restricts Planner to a minority of Briefs. Building schema infrastructure for a sometimes-Phase-0 output is a poor trade.
- **Sandbox is already shared across phases sequentially.** Per `.claude/rules/shell/sandbox-discipline.md`, phases run sequentially in one sandbox session; the Implementer Tachikoma starts after the Planner Tachikoma exits, with `/work/.major/` still populated. File-passing is the natural primitive.
- **Cyberbrain authority is for lifecycle, not transient inputs.** The Plan does not transition Brief Status, does not gate Run finalization, and is not produced for human review. Putting it behind `major.brief_artifacts` would conflate "intermediate phase output" with "final deliverable artifact" — a primitive-boundary smear.
- **Durability through ADR 006 already exists.** The Planner Run's `final_text` column holds the full final assistant message. As long as the Tachikoma's last turn restates the plan (or just emits the plan markdown directly), `runs.final_text` is the durable record. Combined with the prompt-version constant, a Plan is reconstructable from `(planner_run_id, prompt_version, final_text)` without any new schema.
- **AGENTS.md hard rule #2 (Content vs Metadata).** Lifecycle code reads structured columns; content is opaque. A Markdown plan file is content; nothing in lifecycle code reads it. Treating the plan as content honors the boundary.
- **Implementer prompt amendment is small.** Adding a "PLAN" section to the Implementer prompt that conditionally reads `/work/.major/plan.md` is a few lines and a `PLANNER_PROMPT_VERSION` + `IMPLEMENTER_PROMPT_VERSION` bump.

## Decision

The Planner Tachikoma's output contract is a Markdown file at `/work/.major/plan.md`. The Implementer prompt reads it and includes it as context. No new Brief Artifact, no new `artifact_type_contracts` row, no schema change.

### Mechanics

1. **Planner Tachikoma writes** `/work/.major/plan.md` as the entirety of its produced output. The file is Markdown — no enforced section schema in v1, but the prompt directs Planner to include the four sections from the existing stub: files to add/edit/delete, change order, verification strategy, risks/assumptions. The Planner's final assistant message restates the same content (so it lands in `runs.final_text` via ADR 006's path).
2. **Planner Tachikoma is read-only on the repo.** No edits, no commits, no pushes. The only writes are to `/work/.major/plan.md`. (Same posture as today's stub.)
3. **Implementer prompt is amended** to read `/work/.major/plan.md` if it exists and include it as a "PLAN" section ahead of the existing "BRIEF" section. If the file is absent (Planner did not run for this Brief), the section is omitted and Implementer behaves as today.
4. **Plan is durably observable** via:
   - `runs.final_text` on the Planner Run (ADR 006).
   - `tachikoma-stream-event` Telemetry Records on the Planner Run (ADR 006).
   - Optionally `runs.summary` if the Shell hoists a one-line gist.
   No SQL on `brief_artifacts`, no new index, no migration.
5. **The JSON envelope on stdout's last line stays** as the Shell's machine-readable signal (`scope_check`, `files_planned`, `estimated_iterations`). The Shell parses it for verification record fields and to detect `scope_check === "expansion-needed"` (which routes the Brief to `ready-for-human` with no Implementer phase).
6. **Sandbox-discipline rule preserved.** `/work/.major/plan.md` is wiped between Briefs along with the rest of `/work/.major/` per the existing per-Brief cleanup.

### What this ADR does not do

- Does not define the Planner gate (which Briefs it runs on). That is policy — set in this ADR's companion implementation PR per the briefing's Phase 1 Decision 1 (`epic` / `parent` / multi-`expected_paths`).
- Does not define Planner verification requiredness. Per the briefing's Phase 1 Decision 3, the `tachikoma-planner` Verification Result is advisory in v1 (`required=false`).
- Does not introduce a UI surface for the plan. Brief Detail does not render `runs.final_text` for the Planner Run today; that is a separate UI follow-on if it proves useful.
- Does not couple Planner output to Reviewer or Repair phases. If a future ADR adds plan-aware Reviewer or Repair behavior, it can reach `runs.final_text` of the Planner Run via the Cyberbrain — Markdown is fine for an LLM consumer; structured JSON is unnecessary for the v1 use case.
- Does not address what happens if Planner runs and fails *before* writing the plan file. Per Decision 3 (advisory), the Implementer Tachikoma still runs; the absent file case is already specified above.

### Numbering note

Per `docs/adr/README.md`, ADR numbers are monotonically increasing from `001`. Existing files: `001`–`009` and `012`. ADR numbers `010` and `011` are reserved per `docs/plans/intake-and-stubs/00-briefing.md` Phase 3 sub-phases (`010` = inbound issue → Triage Session, `011` = outbound Brief → issue sync). ADR 012's "working title `013 — Run retry budget`" is a non-binding label; the retry-budget ADR will take the next available number when it is drafted (likely `014`).

## Consequences

### Positive

- **Smallest surface that meets v1 needs.** No schema change, no new endpoint, no new artifact-type contract, no new UI. The implementation PR is bounded to: Planner prompt edit (bump `PLANNER_PROMPT_VERSION`), Implementer prompt edit (bump `IMPLEMENTER_PROMPT_VERSION`), `runPlanner` wiring in `shell/main.ts`, the gate check, and a `tachikoma-planner` Verification Result write.
- **Primitive boundary respected.** The Plan is intermediate phase input, not lifecycle artifact. Putting it behind `major.brief_artifacts` would have conflated those primitives. Sandbox file + `runs.final_text` is the right shape.
- **Durability covered for free.** ADR 006's stream-json telemetry already captures the Planner's final assistant message into `runs.final_text`. Plan is reconstructable from `(planner_run_id, final_text)` without any schema work.
- **Reversible.** If a future need emerges to surface plans in the UI, query plans across Briefs, or have Reviewer compare diff to plan, the migration path is "promote `/work/.major/plan.md` to a Brief Artifact" — a one-time additive change. Nothing about this v1 decision blocks that promotion.

### Negative

- **No SQL surface for plan content.** Operators cannot `select count(*) from brief_artifacts where type = 'plan' and brief_id = $1` because there is no `plan` artifact type. To inspect a plan, the operator joins through `runs.purpose = 'plan'` (or the equivalent role marker) and reads `final_text`. Acceptable in v1 because the population is small and the access pattern is forensic, not routine.
- **Plan text bounded by `runs.final_text` size.** ADR 006 says the column "size is bounded by the Tachikoma's own output budget." Pathologically long plans (rare; the gate restricts Planner to scoped multi-path Briefs) will truncate at the Tachikoma's `--max-turns` and wall-clock ceiling, same as any other Tachikoma output. Acceptable.
- **Reviewer/Repair coupling is unstructured.** A future Reviewer prompt that wants to compare diff to plan reads Markdown, not JSON. LLM consumers handle Markdown fine, but a future automated check ("the diff touched files not in the plan") would need a parser or a structured plan. If that becomes a real need, an ADR succeeds this one and promotes the plan to a Brief Artifact.
- **Sandbox-coupling is implicit.** Implementer reading `/work/.major/plan.md` directly assumes the prior Planner phase wrote it. The phase-discipline rule (sandbox-discipline §Phase Discipline) already guarantees sequential-in-same-sandbox, so this is robust — but it is a coupling that would not survive a (hypothetical) future split where phases run on different Shells. That split would itself be ADR-class; this ADR does not foreclose it but it is one of the things that ADR would have to address.

### Follow-on work

- **Planner prompt rewrite.** Replace the `**(STUB)**` framing with the wired contract; reference this ADR in a leading comment. Bump `PLANNER_PROMPT_VERSION` to `planner@2026-05-10` (today). Fix the two pre-rename leftovers in the current stub (`runner/main.ts` → `shell/main.ts`; `/work/.major/item.json` → `/work/.major/brief-<id>.json`).
- **Implementer prompt amendment.** Add the conditional "PLAN" section that reads `/work/.major/plan.md`. Bump `IMPLEMENTER_PROMPT_VERSION`.
- **Shell wiring.** `shell/main.ts` `executeRun` adds a `runPlanner` call gated on `epic` / `parent` classification or `expected_paths.length > 1`, before the existing `runImplementer` call. The gate logic is small and lives next to the existing implementer call site.
- **Verification result.** A `tachikoma-planner` Verification Result is written from the Planner Run with `required=false` (advisory; per Decision 3) and `requiredness_source="artifact-type-policy"`. Mirrors the `tachikoma-reviewer` shape at `shell/main.ts:429–442`.
- **Telemetry-tab renderer (PR #53)** must handle the new `planner@2026-05-10` `promptVersion` cleanly. Verify on the first Planner Run.
- **Slice as 2–3 PRs** per the briefing: this ADR is the first; minimal wiring with Markdown output is the second; gating + the advisory verification check is the third (or second if folded together is cheap).

### Revisit conditions

- **Reviewer or Repair phases want structured plan steps.** If a future ADR promotes Reviewer-checks-plan or Repair-reads-plan to first-class behavior with automated comparisons, promote `/work/.major/plan.md` to a Brief Artifact with a structured body. This ADR is superseded.
- **Plans become consumer-facing in the UI.** If Brief Detail wants a "Plan" tab rendered from queryable structured data (not Markdown lifted from `final_text`), the same artifact-promotion ADR applies.
- **The Planner population grows past gated minority.** If Decision 1's gate broadens to "every Brief," Plans become routine output of every Run. Worth re-evaluating whether sandbox-only durability is still right, or whether the access pattern shifts from forensic to routine.
- **A future split routes phases to different Shells.** That ADR would need to define how Plans reach Implementer across Shell boundaries (an artifact promotion is the obvious answer).

## References

- `docs/plans/intake-and-stubs/00-briefing.md` — Phase 1 of this plan; the briefing flagging the output contract as decision-class.
- `shell/prompts/planner.md` — current stub; this ADR fixes its contract.
- `shell/prompts/implementer.md` — receives the conditional "PLAN" section as part of the implementation PR.
- `shell/prompts/versions.ts` — both `PLANNER_PROMPT_VERSION` and `IMPLEMENTER_PROMPT_VERSION` bump on the implementation PR per AGENTS.md hard rule #7.
- `shell/main.ts` `executeRun` — receives the `runPlanner` call site, ahead of `runImplementer`.
- ADR 006 — Tachikoma stream-json telemetry; the durability path for plan text via `runs.final_text`.
- ADR 005 — Command observability; the sandbox `.claude/settings.json` posture under which the Planner Tachikoma also runs.
- `.claude/rules/shell/sandbox-discipline.md` — phase discipline (sequential-in-same-sandbox) and per-Brief cleanup that this ADR depends on.
- `SPEC.md` §Tachikoma roles + prompts — the place the Planner role exists; the wiring this ADR enables.
- `docs/CONTEXT.md` — Brief Artifact definition; the primitive this ADR deliberately does not extend.
