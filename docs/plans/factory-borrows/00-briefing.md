# Factory AI vs. Major — Briefing for the Grill

A self-contained briefing for a Claude that has just been spawned to grill the question: **what should Major borrow from Factory AI's CLI to make Major a better orchestrator?**

This document is the entry point. Read it first. Then read the five proposal docs in this directory (`01-…` through `05-…`). Each is a draft ADR — `Status: Proposed`. None has been ratified.

The grilling target: stress-test each proposal against Major's existing primitives, the Hard Rules in the root `CLAUDE.md`, and the decisions already cemented in `docs/adr/`. Reject anything that violates a Hard Rule. Push back on any proposal that could be expressed by extending an existing primitive (path-blocker, Triage Change Set, Cyberbrain schema) instead of adding a new one.

## What Factory is

Factory AI ships a CLI agent called **Droid** (`droid exec`, `droid` interactive). It's positioned as a developer tool — a polished, extensible coding agent that runs locally or on managed/BYOM compute. Their docs site exposes a canonical index at `https://docs.factory.ai/llms.txt` listing ~110 pages.

The cluster relevant to Major:

| Factory page | What it documents |
|---|---|
| `cli/features/missions` | Plan-then-execute flow for multi-feature work; "Mission Control" tracks features + milestones |
| `cli/configuration/custom-droids` | User-defined subagents (markdown + frontmatter, project or user scope) |
| `cli/features/droid-computers` (+ `-byom`) | Persistent compute environments, managed or bring-your-own |
| `cli/droid-exec/overview` | Headless one-shot CLI mode; `--auto low|medium|high`, `--session-id`, `--output-format stream-json` |
| `cli/configuration/{skills,mcp,hooks-guide,plugins}` | Extension surfaces |
| `reference/hooks-reference` | 9 lifecycle hooks (PreToolUse, PostToolUse, etc.) |
| `enterprise/llm-safety-and-agent-controls` | Org-level command risk classification, hierarchical settings, Droid Shield |
| `changelog/{1-9,1-10}` | Recent additions: Custom Droids, Mixed Models, MCP Manager UI, Hooks |

## Concept-by-concept mapping (Factory ↔ Major)

| Factory term | Major term | Notes |
|---|---|---|
| **Mission** | **Brief** (loose) | Mission carries a feature/milestone tree built *during* agent contact; Brief is structured at intake. |
| **Droid / Custom Droid** | **Tachikoma role prompt** | Same pattern. Factory: markdown+frontmatter, user/project scope. Major: TS modules, versioned constants. |
| **Droid Computer** | **Shell** | Strongest 1:1. Factory persists by design; Major requires `/work` cleanup between Briefs. |
| **Session** | **Run** | Factory sessions are resumable; Major Runs are single-shot, finalized atomically. |
| **Skill** | *partial — `.claude/rules/` + prompts* | Major has no first-class user-defined skill primitive. **(See proposal 03.)** |
| **Plugin / MCP / Hooks** | *no analog* | Major has no extension distribution surface. |
| **Command Risk Classification** | *no analog (path-blocker is the file axis)* | **(See proposal 02.)** |
| **Hierarchical org/project/user settings** | flat path-blocker config | **(See proposal 01.)** |
| **`droid exec --output-format stream-json`** | *no analog (only start/end events recorded)* | **(See proposal 04.)** |
| **`disable-model-invocation` on Skills** | monolithic role prompts | **(See proposal 05.)** |
| *no analog in Factory* | **Single Active Run Rule** | Partial unique index `runs(brief_id) where outcome='running'`. |
| *no analog in Factory* | **Idempotency keys on every Event** | `(brief_id, event_type, source_actor, source_delivery_id)`. |
| *no analog in Factory* | **Triage Change Sets (propose/apply separation)** | State changes go through propose → path-blocker gate → apply. |
| *no analog in Factory* | **Instruction Trust Boundary** (verbatim prompt opener) | Prompt-injection defense for adversarial PRDs. |
| *no analog in Factory* | **Heartbeat + Lease + Reaper** | 30s heartbeat, 90s lease, Reaper cancels expired Runs. |

## What Factory has that Major doesn't (the borrowable surface)

1. **Hierarchical, non-weakening policy scope.** Factory's org-level deny lists cannot be widened by projects or users. Major's path-blocker is flat. → **Proposal 01.**
2. **Command Risk Classification.** A second authorization axis (commands) orthogonal to the file axis (path-blocker). → **Proposal 02.**
3. **Skills as a first-class, model-discoverable primitive.** Description-driven, scoped, optionally model-invocable. → **Proposal 03.**
4. **Stream-json telemetry shape.** Structured event stream with a final completion containing `finalText`, `numTurns`, `durationMs`. → **Proposal 04.**
5. **`disable-model-invocation` flag.** Capability the operator can invoke but the model cannot self-select. Major's analog: operator-invocable prompt sections. → **Proposal 05.**

## What Major has that Factory doesn't (do NOT trade these away)

The grill must protect these — they are Major's actual contribution to the orchestrator design space.

1. **Single Active Run Rule.** Partial unique index makes double-execution structurally impossible. Factory has nothing equivalent.
2. **Idempotency keys on every retryable write.** Replay-corruption is structurally impossible. Factory's documented API doesn't surface this.
3. **Propose / apply separation (Triage Change Sets) gated by path-blocker.** State changes are not side effects of agent reasoning. Factory state changes happen as the Droid acts.
4. **Cyberbrain as source of truth.** Hard Rule #1: lifecycle code reads structured columns, not Brief Content. Factory's Mission state is distributed across agent + session + computer surfaces.
5. **Instruction Trust Boundary.** Verbatim prompt opener that survives any user-extensibility decision. Factory relies on hooks the user must configure.
6. **ADR-as-checkpoint.** Non-trivial schema and policy changes require an ADR before code lands. Factory's policy is config-driven and editable at runtime.

If a borrow weakens any of these, the borrow is wrong as drafted.

## Recent Factory direction (changelog 1.9 + 1.10)

- **1.9** — Custom Droids (user-defined subagents), Mixed Models (per-phase model selection), GitHub App for PR review.
- **1.10** — MCP Manager UI, Hooks (experimental), completion sounds.

Signal: Factory is investing in **user-side extensibility**. They are *not* visibly investing in DB-grade lifecycle invariants, propose/apply separation, or transactional API endpoints. Trajectory diverges from Major's, and should — Factory is a developer tool, Major is an orchestrator.

## Grilling notes for the next Claude

1. **Hard Rules first.** Open the root `CLAUDE.md` and `.claude/rules/` paths. Any proposal that violates a Hard Rule (Cyberbrain authoritative, content-vs-metadata, propose/apply separation, Single Active Run Rule, path-blocker non-optional, idempotency keys, prompt versioning, PRs target `dev`, no secrets in code) gets rejected, not refined.

2. **Cite SPEC.md.** Each proposal must point at the lines of `SPEC.md` it touches (schema, lifecycle, API). If `SPEC.md` is silent and the proposal is decision-class, that's the right trigger for an ADR — but the ADR has to acknowledge what `SPEC.md` will need to grow to support it.

3. **Existing primitives first.** Before accepting a new primitive (a new table, a new edge function, a new prompt loader), ask: can this be done by extending Triage Change Sets, the path-blocker config, or `major.events`? A new primitive is a real cost; the bar is high.

4. **Determinism.** Major's invariants (Single Active Run, idempotency, path-blocker, Reaper) are deterministic and DB-enforced. Borrows that introduce non-deterministic behavior (LLM-scored risk, runtime config drift, hook-based escape valves) need explicit justification.

5. **Audit trail.** Every state change in Major lands as an Event with an idempotency key. Borrows that bypass `major.events` for "performance" or "simplicity" should be challenged hard.

6. **Scope honesty.** Two of the five proposals (01, 02) are infrastructural and survive light scoping. Three (03, 04, 05) are user-extensibility features whose value depends on usage that doesn't yet exist. The grill should probe whether the project is at the size where each makes sense, or whether some are premature.

## Files in this directory

- [00-briefing.md](./00-briefing.md) — this document
- [01-hierarchical-policy-scope.md](./01-hierarchical-policy-scope.md) — hierarchical, non-weakening policy scope for the path-blocker
- [02-command-risk-classification.md](./02-command-risk-classification.md) — second authorization axis: command risk
- [03-skills-primitive.md](./03-skills-primitive.md) — first-class Skills in the Cyberbrain
- [04-stream-json-tachikoma.md](./04-stream-json-tachikoma.md) — structured Tachikoma telemetry via stream-json
- [05-operator-invocable-prompt-sections.md](./05-operator-invocable-prompt-sections.md) — split role prompts into model-invocable and operator-invocable sections

When the grill ratifies a proposal, it gets renamed to `docs/adr/NNN-<title>.md`, status flipped to `Accepted`, indexed in `docs/adr/README.md`, and any required schema migration drafted in `db/`.
