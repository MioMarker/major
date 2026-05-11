# 019. Heartbeat lease length: 300s (5 min) with 30s heartbeat cadence

## Status

`Accepted`

Date: 2026-05-11

## Context

The Shell holds a lease on a Brief while it runs. The lease is renewed by periodic heartbeat calls to `major-heartbeat`. If the Shell fails to renew, the Reaper marks the Run cancelled so another Shell can claim the Brief.

Two conflicting values exist in the codebase:

- `major-claim-brief/index.ts` and `major-heartbeat/index.ts`: lease duration = **300s (5 minutes)**, heartbeat cadence = **30s**.
- `.claude/rules/shell/sandbox-discipline.md`: states the lease is **90s**, with heartbeat at 30s.

The 90s figure was aspirational — written during design. The code shipped with 300s and has been operating that way since the first Shell deployment. The 2026-05-09 audit (finding F-09) surfaced the divergence.

### Alternatives considered

1. **Keep 300s, update the rule** (chosen) — matches operating reality. The 300s window gives the Shell generous recovery time when a phase is slow (LLM latency spikes, CI poll loops). Updating the rule eliminates the confusion.
2. **Shorten to 90s, update the code** — aligns with the original design intent. Provides faster failure detection. Requires changes to `major-claim-brief`, `major-heartbeat`, and the Shell's heartbeat loop. Risk: if a Tachikoma phase takes >90s (plausible on a large diff), the Shell loses its lease mid-phase even though it's healthy.
3. **Make lease length configurable** — over-engineering for v1. Adds a config field with no clear benefit until we have data on actual phase durations.

### Forces

- The Shell heartbeats every 30s. With a 90s lease, the Shell has only 2 missed heartbeats before it loses the claim. Network hiccups or a slow LLM response can easily cause 2 consecutive missed heartbeats.
- With a 300s lease, the Shell has ~9 missed heartbeats of margin. This is more forgiving for v1 where we want to understand failure modes before tightening.
- The audit also found that the Shell ignores `renewedRun=false` from heartbeat (finding F-10), so the lease length has been academic until that fix lands. Once F-10 is fixed (Stream D), the lease length becomes load-bearing.
- Changing the lease length requires deploying both the edge functions and the Shell container in lockstep. Avoiding that deployment complexity for now is worthwhile.

## Decision

**Lease duration stays at 300s. Heartbeat cadence stays at 30s.**

`.claude/rules/shell/sandbox-discipline.md` is updated to reflect 300s and to explain the reasoning (generous margin for v1; revisit after we have data on phase durations). The code is not changed.

## Consequences

**Positive:**
- No code change required. Only the rule document updates.
- 300s gives the Shell a comfortable failure window; false-positive Reaper sweeps are minimized.
- Once Stream D fixes the heartbeat-loss abort (finding F-10), the system will behave correctly with the current 300s lease.

**Negative:**
- A Shell that hard-crashes takes up to 5 minutes before the Reaper reclaims its Brief. This is the "zombie lease" window. Acceptable for v1 given the low instance count.

**Follow-on work:**
- Update `.claude/rules/shell/sandbox-discipline.md` § "Heartbeat Fidelity" to say 300s, not 90s.
- Stream D: fix heartbeat-loss abort (finding F-10) so the lease is actually enforced at the Shell level.
- After 30 days of production data, revisit lease length. If average phase duration is consistently under 60s, shortening to 120s is reasonable.
