# Architecture Decision Records (ADRs)

This directory captures **non-trivial architectural decisions** for Major. Each ADR is a short, immutable record of a decision: the context that forced it, the choice we made, and the consequences we accept.

Major's `SPEC.md` is the authoritative source for primitives, lifecycle, schema, and API surface. ADRs sit alongside the spec and explain **why** specific choices were made — especially the ones a future contributor (or AI agent) might reasonably re-litigate.

## When to write an ADR

Write one when the decision:

- Is **non-trivial** — it took meaningful thought, considered alternatives, or has long-lived consequences.
- **Changes later behavior** — future contributors (or AI agents) will need to know why the code looks this way.
- Is something **AI agents should follow** — a convention applied across the codebase, not just in one PR.
- **Constrains future options** — adopting a library, picking a data format, choosing a deployment target, defining a state-machine transition rule.

You do **not** need an ADR for routine bug fixes, small refactors, or implementation details that are obvious from the code.

## How to write one

1. Copy [`000-template.md`](./000-template.md) to a new file named `NNN-kebab-title.md`, where `NNN` is the next monotonic number starting from `001`.
2. Fill in **Status**, **Context**, **Decision**, and **Consequences**. Mirror the section structure of the existing ADRs.
3. Add an entry to the [Index](#index) below.
4. Commit the ADR alongside the change it describes (or just before, if the change is large).

## Naming convention

- `NNN-kebab-title.md` — three-digit zero-padded number, monotonically increasing from `001`.
- The title is short, kebab-case, and describes the **decision** (not the problem). Good: `004-adopt-pg-cron-for-reaper.md`. Bad: `004-stuck-leases-issue.md`.
- `000-template.md` is reserved for the template itself.

## Lifecycle

ADRs are **immutable** once accepted. If a decision is revisited:

- Mark the old ADR's **Status** as `Superseded by NNN`.
- Write a new ADR explaining the new decision and link back to the old one.

This preserves the historical record of why we believed what we believed at the time.

## Index

- [001 — Major's lifecycle model is derived from RelyMD's Foundry](./001-major-derived-from-foundry.md)
- [002 — Path-Blocker Rule decides which Triage Change Sets need human apply](./002-path-blocker-rule.md)
- [003 — `dev` is the integration branch; `main` is the release branch](./003-dev-as-integration-branch.md)
- [004 — Ghost in the Shell naming convention](./004-ghost-in-the-shell-naming.md)
- [005 — Tachikoma command observability and policy via Claude Code permissions](./005-tachikoma-command-observability.md)
- [006 — Structured Tachikoma telemetry via Claude Code stream-json output](./006-tachikoma-stream-json-telemetry.md)
- [007 — Auto-close Brief and source GitHub issue on PR terminal events](./007-auto-close-brief-and-issue-on-pr-terminal.md)
- [008 — Tachikoma bash deny list v1 — Phase 2 calibration and seed](./008-tachikoma-bash-deny-list-v1.md)
- [009 — PreToolUse hook discrimination for ad-hoc package installs](./009-package-install-hook-rule.md)
- [010 — Inbound GitHub issue → Triage Session (opt-in via `needs-triage` label)](./010-inbound-github-issue-to-triage-session.md)
- [011 — Outbound Brief → source GitHub issue resolution comment](./011-outbound-brief-to-issue-resolution-comment.md)
- [012 — Failed-Run disposition: park at `ready-for-human`, defer retry budget](./012-failed-run-disposition.md)
- [013 — Planner output contract: Markdown plan file at `/work/.major/plan.md`](./013-planner-output-contract.md)
- [014 — Run retry budget: per-Brief cap, resets on new Content Revision, auto-attempt below cap](./014-run-retry-budget.md)
- [015 — `major-shell-bot` GitHub identity authors all Shell-opened PRs](./015-major-shell-bot-identity.md)
- [016 — `merge-blocked` Brief status for Mode 1 attempt failures](./016-merge-blocked-brief-status.md)
- [017 — Mode 1 per-PR algorithm upgrade: pre-flight + approve + merge](./017-mode-1-pre-flight-merge-algorithm.md)
- [018 — Triage Change Operation payload casing: snake_case in JSONB, camelCase on TS interfaces](./018-change-operation-payload-casing.md)
- [019 — Heartbeat lease length: 300s (5 min) with 30s heartbeat cadence](./019-heartbeat-lease-length.md)
- [020 — Test framework split: pgTAP for RPCs, Deno test for edge functions, Vitest for Shell](./020-test-framework-split.md)
- [021 — PR Derived Facts storage: JSONB column on `major.briefs`](./021-pr-derived-facts-storage.md)
