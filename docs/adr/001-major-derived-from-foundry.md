# 001. Major's lifecycle model is derived from RelyMD's Foundry

## Status

Accepted

Date: 2026-05-09

> Note: ADR 004 supersedes some component names — Work Item → Brief, Runner Instance → Shell, database/Workflow Store → Cyberbrain.

## Context

Major's design draws directly from RelyMD's Foundry (`~/Projects/platform/common/docs/foundry/`), the production system that implements RelyMD's Triage / AFK Agent Loop. Foundry's domain model — Work Items, Triage Sessions, Triage Change Sets, Runs, Runner Instances, Verification Results, Repository Correlation Receipts — was studied directly and adopted with minimal renaming (`Foundry` → `Major`, schema `foundry.*` → `major.*`, branch prefix `foundry/` → `major/`).

This ADR records the inheritance, the deliberate cuts, and a few Major-specific additions, so future contributors and AI agents don't re-litigate decisions that are already settled.

### Why directly inherit

- The Foundry team has paid the design cost of distinguishing primitives that *seem* similar but aren't (e.g., Event vs Telemetry Record, Pull Request Status vs Work Item Status, Run Coordination Metadata vs Run Metadata, Repair Run vs continuing original Run). Re-deriving these is wasteful.
- Foundry's vocabulary is rigorous and avoids names that smuggle assumptions (`Workflow Store` is not "the database," `Actor` is not "owner"). Adopting it gives us the same precision.
- Major and Foundry serve different scales (two-dev personal-ish system vs RelyMD-team production), so a verbatim port would be over-engineered. Cuts are explicit.

### Forces

- Major must ship fast. A full Foundry port would take weeks.
- Major must remain easy for AI agents to reason about. Sharing vocabulary with Foundry means agents pre-loaded on Foundry skills can navigate Major without re-orientation.
- Major drives two existing repos (HealthBite + Healix); each Item targets exactly one repo. Multi-repo per Item adds complexity we don't need.
- Major's two devs co-own everything. Per-Item assignment, priority tiers, escalation rules, and SLAs are over-engineered for our scale.

## Decision

Major adopts Foundry's lifecycle model as the working spec, with the following deliberate **cuts** and **additions**.

### Adopted primitives (kept)

All Foundry primitives in: App boundary, Triage, Work Item, Intent representation, Actor and authority, Run primitives (including all four purposes: execute, review, triage, repair), Cancellation/handoff, Artifact, Verification, Repository integration, Telemetry, Event/idempotency.

### Cuts (deferred or out of scope)

| Cut | Rationale |
|---|---|
| **Assignment Metadata** | Two-dev co-ownership; FIFO + `queue_rank` is sufficient |
| **Multi-repo per Item** | Each Item names one Git Repository Reference; cross-repo work splits across separate parents (with a meta-parent that has no Git Branch) |
| **Maintainer Override** | n/a at our scale |
| **Artifact Cleanup Policy (wired)** | Manual cleanup; no janitor job in v1; primitive exists in spec for future re-introduction |
| **Automated Acceptance Policy (wired)** | Primitive exists in `artifact_type_contracts`; no policy granted automation in v1; humans always accept |
| **Time-based policy (SLAs, due dates, escalation timers)** | Out of scope |
| **Realtime in-app edit mode + voice + context awareness** | Out of scope; replaced entirely by Triage Sessions |
| **Declarative agent fleet API** | Fixed runner pool count via env config; no kubectl-style declarative for v1 |

### Major-specific additions (not in Foundry)

| Addition | Rationale |
|---|---|
| **Path-Blocker Rule** | Major auto-applies most Triage Change Sets without human review. Path-blocker is the deterministic check that decides which Sets need human apply (touches protected globs OR mass-reranks > 5 Items). Foundry leaves this to human judgment per Item; we automate it. |
| **`needs-info` and `ready-for-human` as core states** | Foundry has these too, but Major makes them v1 first-class (not deferred). Real failure modes need a pressure release. |
| **Single source of truth for `major.*` schema in dev Supabase** | Foundry has its own DB; Major reuses an existing Supabase dev project under a new schema. Keeps deployment lean. |

## Consequences

**Positive:**

- Major ships in days, not weeks. The design doesn't need to be rediscovered.
- AI agents trained on Foundry skills (`foundry` orientation skill at RelyMD) can navigate Major immediately — same primitives, same patterns.
- The decisions in this ADR explicitly set the boundary. Future contributors know what's intentionally out of scope and what's a real gap.

**Negative:**

- Inheritance creates legibility risk: someone reading Major might assume Foundry-equivalent behavior in places where we've cut. Mitigated by `SPEC.md` being self-contained and by this ADR enumerating cuts.
- We're tied to Foundry's vocabulary. If Foundry renames something, Major drifts unless we re-pull. We accept this as cheaper than maintaining a separate vocabulary.
- Some cuts (e.g., declarative fleet, multi-repo per Item) will need real ADRs to reverse if scale changes. The cuts here are not permanent — they're v1.

**Follow-on work:**

- Build out `docs/CONTEXT.md` as a domain glossary that mirrors Foundry's (~70 primitives), with each entry annotated as `[adopted]`, `[adopted with simplification]`, or `[Major-specific]`.
- When adopting an additional Foundry primitive (e.g., re-enabling Artifact Cleanup Policy), open a new ADR rather than silently extending the model.
- If a Foundry primitive proves load-bearing in Major that we haven't enabled, file an issue with the title `Adopt Foundry primitive: <name>` and link this ADR.
