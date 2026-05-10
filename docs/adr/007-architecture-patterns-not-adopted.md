# 007. Architecture patterns explicitly not adopted

## Status

Accepted

Date: 2026-05-09

## Context

A 2026-05-09 architecture grill against two external documents — a "Mission-Centric Multi-Agent SDLC" specification and an "Engineering Reliability Standards" architecture document — produced ratifications (ADRs 005 and 006) and deferrals (recorded as `Deferred` in `docs/plans/factory-borrows/` and in conversation context for the Mission, User Testing Validator, and Circuit Breaker proposals).

The same grill produced rejections of three patterns whose load-bearing reasoning needs a durable home so future contributors reading the same documents do not re-litigate. This ADR is that home.

## Decision

Major explicitly does NOT adopt the three patterns below. Each rejection records a load-bearing reason and a lock-in clause that any future ADR proposing adoption must first satisfy.

### 1. Saga / Compensate pattern for transactional consistency

The pattern: every agent in the architecture implements `Execute` and `Compensate` methods. On terminal failure, the orchestrator walks the execution log backward and calls `Compensate` on each successfully-completed agent in reverse order. Adopted in distributed systems where multiple uncoordinated services hold partial state and ACID transactions are impractical.

Major does NOT adopt this. Major's recovery model is forward-only retry plus DB transaction rollback. The atomic Run Start Transaction and Run Finalization Transaction (per `.claude/rules/functions/edge-functions.md`) make Cyberbrain mutations all-or-nothing; the only mutation outside Cyberbrain transactions is to a Brief-scoped throwaway branch on GitHub (`major/brief-<id>`), which is structurally isolated from `dev` and `main` by branch protection (per ADR 003).

For that branch, leaving partial commits in place is *better* than compensating: the next Run picks up the branch and either continues or replaces those commits. Force-pushing a revert as compensation would discard work the next claim could have used. The Reaper (lease expiry → System Run Cancellation → Brief returns to `ready-for-agent`) is the existing compensation pathway for the only failure mode that needs one.

**Lock-in clause:** any future ADR proposing Saga/Compensate must first demonstrate a specific failure mode that the existing Run Start / Run Finalization Transaction + branch-persistence model cannot handle, AND show why backward compensation is preferable to forward retry for that mode.

### 2. Full Immutable State Snapshots

The pattern: state is never updated in place. Frozen objects post-creation; every change appended as a new row in a versioned log; schema validation at every handoff.

Major does NOT adopt the full pattern. The mutation of `briefs.status` and `runs.outcome` in place is load-bearing: the Single Active Run Rule (one of Major's six protected invariants) is enforced via the partial unique index on `runs(brief_id) where outcome='running'` and via the atomic `UPDATE major.briefs SET status='agent-running' WHERE id=$1 AND status='ready-for-agent'` compare-and-swap inside the Run Start Transaction. Removing in-place mutation removes both enforcement points without an equivalent replacement.

Major DOES adopt append-only patterns where they earn their keep without breaking invariants: `brief_content_revisions` (versioned PRD content), `events` (lifecycle audit trail with idempotency keys), `telemetry_records` (non-lifecycle observation), `verification_results` (per-Run check outcomes), `path_blocker_config` (current effective row is most recent un-superseded). Schema validation at boundaries is done via Zod (per `.claude/rules/common/coding-style.md`).

The cache-invalidation failure mode that motivates the document's pattern (an agent reading stale data from a cache that wasn't invalidated) does not apply: Major has no cache layer between Cyberbrain and consumers.

**Lock-in clause:** any future ADR proposing full event sourcing must first show what new failure mode the existing append-only `events` table does not capture, AND propose an alternative Single Active Run Rule enforcement mechanism cheaper than the current partial unique index.

### 3. Data Contracts with `confidence_score` rejection thresholds

The pattern: every agent output carries `confidence_score`, `sources`, `timestamp`, `version_id`. Downstream agents reject handoffs where confidence is below a threshold (e.g., 0.7).

Major does NOT adopt confidence-score gating. Three of the four contract fields are already covered by existing primitives:
- `timestamp` — every Event and Telemetry Record has `created_at`.
- `version_id` — every Run, Event, Brief, Artifact has a UUID.
- `sources` — Event has `source_actor` (`'human' | 'agent' | 'shell' | 'integration'`); ADR 006 stream-json telemetry surfaces tool-call sources (Read, Grep) per Run.

The fourth (`confidence_score`) introduces LLM-self-assessed confidence as a gating signal. LLMs are poorly calibrated on self-confidence — confident wrong answers happen often (hallucinated certainty), uncertain right answers happen too. The threshold value is invented; nothing in the document defends it. Adopting confidence-score gating would parallel the existing path-blocker (a deterministic gate) with a non-deterministic one.

Major's gating discipline relies on deterministic signals: `tsc --noEmit`, tests, glob match, idempotency conflict, partial unique index. These have known false-positive/false-negative characteristics and are auditable. Adding confidence-score gating dilutes that property.

Where confidence-like signals genuinely matter, Major already captures them via Verification Results (`required: bool` + `Verification Requiredness Source`).

**Lock-in clause:** any future ADR proposing confidence-score gating must first show a specific gate where confidence scoring catches a class of bug deterministic checks cannot, AND defend the threshold value with calibration data, not vibes.

## Consequences

**Positive:**

- Future contributors reading the rejected documents see Major considered each pattern with specific reasoning, reducing re-litigation cost.
- Reinforces Major's design principles: determinism over LLM-judgment, structural enforcement via DB invariants, forward-only recovery for Brief-scoped git artifacts.
- Makes the bar for revisiting any of the three explicit and falsifiable.

**Negative:**

- Closes off three patterns commonly cited as best practice in distributed-systems and multi-agent literature. If Major's shape ever changes — e.g., adding non-git external mutations across uncoordinated services, or a cache layer between Cyberbrain and consumers — the relevant rejection becomes the wrong call. The lock-in clauses are designed to surface that case.
- The rejections are calibrated to Major's current scope (orchestrator for two devs, two repos, Brief-scoped git artifacts). They do not generalize to systems with materially different shape.

**Follow-on work:**

- None directly. The lock-in clauses are the contract.
- If a deferred proposal (e.g., User Testing Validator, Circuit Breaker, Mission primitive) is later revisited and reshapes Major's scope, audit whether any of these rejections need an update ADR.

## References

- ADR 001 (Foundry-derived domain model — basis for Major's existing recovery model).
- ADR 002 (Path-blocker — the deterministic gate model).
- ADR 005 (Command observability — preserves determinism in command axis).
- ADR 006 (Stream-json telemetry — defends the events-vs-telemetry distinction).
- "Engineering Reliability Standards" architecture document, sections §3 (Immutable Snapshots, Data Contracts) and §5 (Saga pattern) — the source of the patterns rejected here.
