# 002. Path-Blocker Rule decides which Triage Change Sets need human apply

## Status

Accepted

Date: 2026-05-09

## Context

Major auto-applies most Triage Change Sets without human review. This is necessary for two-dev throughput: a triage that requires manual apply on every Change Set turns Major into a wrapper around a manual queue, which defeats the AFK-loop premise.

Foundry, Major's design ancestor (`docs/adr/001-major-derived-from-foundry.md`), leaves the auto-apply / human-apply decision to per-Item human judgment. Foundry runs at RelyMD's scale where a triage operator is always available. Major does not have that luxury — there are two devs and they are not always at a keyboard.

At the same time, certain paths in the dependent repos (HealthBite, Healix) carry irreversible or safety-critical consequences. Auto-applying a Change Set that touches `supabase/functions/chat-with-ai/**` (which is gated by HealthBite's eval pipeline per `.claude/rules/ai/evaluation-pipeline.md`) bypasses the human review the eval gate exists to support. Auto-applying a Change Set that mass-reranks the queue (changes `queue_rank` on > 5 Items at once) is a global ordering change that deserves a human's pause.

Foundry's principle that "auto-application requires explicit policy" forces the question: what is our explicit policy?

### Alternatives considered

1. **Per-classification rule** — every `bug-fix` auto-applies, every `feature` requires human apply. Rejected: classification is orthogonal to risk. A `bug-fix` touching the eval pipeline is more dangerous than a `feature` touching internal-only utilities. Classification predicts work shape, not risk.

2. **LLM-scored risk** — at apply time, ask an LLM to score the Change Set's risk; auto-apply below a threshold, queue for human above it. Rejected: non-deterministic, hard to audit, susceptible to prompt-injection from Work Item Content (which the Instruction Trust Boundary is supposed to neutralize), and adds an LLM call to the critical path.

3. **All-changes-need-human-apply** — no auto-apply at all. Rejected: defeats the AFK-loop premise. Two devs cannot be the bottleneck for every Change Set, especially Auto Triage Run output during off-hours.

4. **Glob-list path-blocker (chosen)** — deterministic, human-readable, version-controlled, easy to revise.

### Forces

- **Two-dev throughput.** Most Change Sets must auto-apply. A typical week might generate dozens; manual apply on each is infeasible.
- **Predictability.** A developer should be able to look at a Change Set's `expected_paths` and know — without running anything — whether it will auto-apply. Glob matching is the simplest predictable rule.
- **Determinism.** The same Change Set against the same config must always make the same decision. This rules out LLM scoring and any non-pure-function logic.
- **Auditability.** The decision must be reconstructable later. Glob matching produces a clear "matched glob X" or "matched no globs" trail; LLM scoring produces narrative.
- **The eval pipeline already has a flip-rule.** `chat-with-ai/**` and `eval/**` are protected because HealthBite's eval gate exists for those paths. The path-blocker should respect the same boundary by default.

## Decision

Major adopts a **glob-list path-blocker rule** with these specifics:

### Rule

A Triage Change Set requires human apply if **either**:

1. Any `expected_paths` value on any `create-item` or `transition-work-item → ready-for-agent` operation in the Set intersects any glob in `path_blocker_config.protected_globs`, **or**
2. The Set contains `set-queue-rank` operations affecting more than `path_blocker_config.mass_rerank_threshold` distinct Items (default `5`).

Otherwise the Set auto-applies.

### Initial protected globs

(Seeded in `db/0001_initial_schema.sql`, editable via UI Settings.)

```
supabase/functions/chat-with-ai/**
eval/**
supabase/migrations/**
.claude/rules/**
app.config.ts
```

Rationale per glob:

- `supabase/functions/chat-with-ai/**` — gated by HealthBite's eval pipeline; auto-apply would bypass the safety gate's surrounding human-review expectation.
- `eval/**` — same reasoning; touches the gate itself.
- `supabase/migrations/**` — schema changes are append-only and irreversible. Always human apply.
- `.claude/rules/**` — agent rule changes affect future agent behavior across the codebase; deserves explicit review.
- `app.config.ts` — controls APP_VARIANT routing and EAS build identity; deserves explicit review.

### Mass-rerank threshold

Default `5`. A Change Set re-ranking `> 5` Items represents a global queue reshuffle, which a human should consciously approve. Set to `0` to disable; set to a higher number to relax.

### Scope

The rule runs at:

- Triage Change Set apply time (every `major-apply-change-set` call).
- Inside Auto Triage Run finalize, on the emitted Change Set, before the Set is queued or applied.

The rule does **not** run on Run Finalization Transactions (those are Run-produced state changes, not Triage proposals; their authority comes from the Run + Verification Results, not from the path-blocker).

## Consequences

**Positive:**
- Predictable: any developer or AI agent can read the protected glob list and know what auto-applies.
- Deterministic: same Change Set + same config = same decision, every time.
- Cheap: pure function, no external calls, runs in microseconds inside the apply transaction.
- Auditable: the matched glob (or empty match) is recorded on the Change Set's `apply_decision` field, queryable forever.
- Aligned with HealthBite's existing eval-gate boundaries: the protected globs reuse the same mental model devs already have.

**Negative:**
- **False positives slow throughput.** A safe Change Set whose `expected_paths` happens to glob-match a protected pattern gets queued for human apply unnecessarily. We accept this — the path-blocker is intentionally conservative.
- **False negatives caught downstream.** A genuinely sensitive Change Set that doesn't match any protected glob auto-applies. Caught later by reviewer Tachikoma (advisory) and by human at QA Confirmation (`docs/failure-modes.md` § 10). This is a real cost, but the alternative — broader globs — increases false positives.
- **Glob-list editing has friction.** Changing `path_blocker_config` requires SQL or a UI Settings edit; not something agents can do mid-Run. We accept this — the rule's authority comes from being hard to bypass.

**Follow-on work:**
- A UI editor for the protected glob list (`Settings → Path-Blocker`). Append-only audit trail; current effective config is the most recent row. Tracked separately.
- Telemetry on path-blocker firings. Each firing writes a Telemetry Record with the matched glob; analyze monthly to inform glob-list refinements.
- **Revisit conditions** for this ADR:
  - When the dev team grows past two and the throughput-vs-human-apply trade-off shifts.
  - When a real false-negative incident occurs (path-blocker missed something it should have caught) — postmortem may add globs or change the rule shape.
  - When a new artifact type beyond `git-change` and `triage-change-set` enters scope and may need a different blocker model.
