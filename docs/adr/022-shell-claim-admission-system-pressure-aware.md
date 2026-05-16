# 022. Major Shell claim admission becomes system-pressure aware

## Status

`Proposed`

Date: 2026-05-11

## Context

Major's Shell claim flow today has **no system-resource awareness**:

- `major.settings.shell_pool_size_hint` (default 2) is a static count of how many Shells should be alive.
- `major.shell_pool_state.paused` is a binary kill switch, currently only flipped for "Anthropic spend cap reached" per `docs/failure-modes.md` § 15.
- `claim_next_brief` checks Brief eligibility and the partial-unique-index Single Active Run Rule, but does not consult host memory, CPU, swap, or any other system signal.

A `claude` process inside a Shell (a Tachikoma) consumes ~1–2 GB resident. With `shell_pool_size_hint = 3` and all three Shells claiming Briefs simultaneously, three Tachikomas spawn back-to-back. On a memory-constrained host (e.g. a 24 GB MacBook Pro running Chrome, the Docker VM, interactive Claude sessions, etc.), this triggers macOS Jetsam — observed in production on 2026-05-10 and 2026-05-11, where Ghostty was OOM-killed (largest-process target) and every interactive `claude` PTY child died with it. Major's Shells survived (they live inside Docker), but the user lost their Ghostty sessions and any in-flight interactive work.

A new orchestrator (PROXY, at `~/Projects/tachikoma-starter`) is being built with pressure-aware admission as a first-class concept. For PROXY v1 we plan to coordinate with Major as follows:

- **Observe**: PROXY's daemon reads Docker stats for all containers (including `shell-A/B/C`) and folds Major's actual RSS into PROXY's own admission budget.
- **Steer**: when host pressure crosses `Warn`, PROXY's daemon writes `UPDATE major.shell_pool_state SET paused=true, paused_reason='memory-pressure'`. Major's Shells already respect this flag and stop claiming new Briefs (per `docs/failure-modes.md` § 15). On pressure clearance, PROXY flips the flag back.

This is a clean v1 because it requires zero changes to Major's code. But it creates an external dependency: Major's memory safety is provided by a sibling project. If PROXY is down, paused, or removed, Major regresses to the crash-prone status quo.

The ADR captures the **commitment that Major should eventually own its own admission gate**, with PROXY-driven coordination as the explicit interim mechanism — not the permanent architecture.

### Alternatives considered

1. **Make Major permanently dependent on PROXY for pressure gating** — rejected. Major should be self-sufficient. PROXY may evolve, be replaced, or be temporarily disabled; Major's memory safety should not depend on it.
2. **Add a pressure check inside `claim_next_brief`** (chosen for long-term) — the claim RPC consults a pressure signal and refuses to return a Brief when pressure is `Warn`/`Critical`. Pressure signal source TBD: Shell-side probe written to a DB row, sidecar service, or pg extension.
3. **Build a separate "admission service" used by both Major and PROXY** — over-engineered for v1. PROXY's daemon is already that service; a separate one duplicates the work.
4. **Have each Shell probe pressure locally before claiming** — possible but pushes responsibility to N Shells instead of one central decision. Race-prone (Shell A and Shell B both pass their local probe in the same second; both claim; both start Tachikomas).

### Forces

- Major's `claim_next_brief` is an SQL RPC running inside Postgres. Postgres cannot directly observe host memory pressure (different VM, different machine, etc.). Pressure signal must be written to the DB by something that *can* observe — historically PROXY's daemon, eventually a Major-owned probe.
- The existing `shell_pool_state` singleton is the natural place to extend. Adding columns like `host_pressure_level`, `host_pressure_updated_at` keeps the schema flat.
- Major's Shells and PROXY's loops both run as Docker containers on the same Docker VM, so they share the same memory budget. Whatever admission rule Major adopts must be reconcilable with PROXY's (so they don't both think they have "enough room" and oversubscribe).
- The Single Active Run Rule (§ "Single Active Run Rule Enforced at API Layer" in `shell/sandbox-discipline.md`) means the right place to insert a pressure gate is at the API layer — specifically inside the Run Start Transaction of `claim_next_brief`. Any code path that performs Run-like work must go through that door (§ "API layer is the only door"), so a single check there covers all paths.
- The user's longer-term direction is a dedicated remote workhorse box (deferred per a separate decision). When that lands, the pressure source becomes the box's host kernel, not the Mac's — but the *mechanism* (DB-mediated pressure flag consulted by `claim_next_brief`) is the same.

## Decision

**Major's `claim_next_brief` RPC will consult a system-pressure signal and refuse claims when pressure exceeds an admission threshold. The implementation is deferred until PROXY v1 ships; in the interim, PROXY's daemon writes the existing `shell_pool_state.paused` flag for pressure events.**

Concretely:

1. **Interim (PROXY v1)** — no Major code changes. PROXY's daemon reads Docker stats + Mach API on the host; when pressure crosses `Warn`, it writes `shell_pool_state.paused = true, paused_reason = 'memory-pressure'`. Major's Shells stop claiming. On clearance, PROXY clears the flag. Existing Tachikomas continue (we never kill running work; see PROXY's Q5 decision for parallel reasoning).
2. **Future (this ADR's full implementation)** — extend `shell_pool_state` (or a related row) with a pressure signal column (e.g. `host_pressure_level enum('normal','warn','critical')`, `host_pressure_updated_at timestamptz`). Build a pressure probe — likely the Shell itself running a periodic `vm_stat` + sysctl pass and writing to the column. Modify `claim_next_brief` to read the column and short-circuit when pressure ≠ `normal`. Stale signals (older than ~30s) are treated as `critical` to fail closed.
3. **`paused_reason` namespacing** — the `paused` flag stays binary, but `paused_reason` becomes the discriminator between "spend cap" (existing) and "memory-pressure" (new). Operators can tell at a glance which subsystem paused the pool.

The full implementation is **out of scope** for the immediate work. This ADR exists to commit to the direction so the interim is recognized as interim and future contributors don't entrench it.

## Consequences

**Positive:**
- Major becomes self-sufficient on memory safety — no permanent dependency on PROXY's continued existence.
- Pressure gate sits at the only door (Run Start Transaction inside `claim_next_brief`), preserving the "API layer is the only door" rule from `shell/sandbox-discipline.md`.
- The two systems (Major and PROXY) use compatible signals (both treating `shell_pool_state` as a coordination point), so coexistence is consistent v1 → v2.

**Negative:**
- Interim phase has Major's memory safety provided externally by PROXY. If PROXY is removed mid-life, Major regresses. Mitigated by the explicit "this is interim" commitment in this ADR.
- Adds a new responsibility (pressure probe) to be designed. Probably belongs in the Shell itself for v2; alternative is a sidecar process.
- Probe staleness handling adds a small surface for false-positive refusals when the probe is briefly delayed.

**Follow-on work:**

- (Deferred) Schema migration to add `host_pressure_level` + `host_pressure_updated_at` to `shell_pool_state`.
- (Deferred) Implement the probe — likely a goroutine in the Shell's main loop sampling host metrics on a 5–10s cadence.
- (Deferred) Modify `claim_next_brief` to consult the pressure signal; treat signals older than 30s as `critical`.
- (Now) PROXY v1 ships the interim coordination as described.
- (Now) `docs/failure-modes.md` § 15 is updated to mention `paused_reason='memory-pressure'` as a valid value in addition to spend-cap.

### Trigger for promoting from `Proposed` to `Accepted`

This ADR moves to `Accepted` when:

1. PROXY v1 has shipped and the interim coordination has run in practice for ≥ 30 days,
2. OR a separate event (PROXY removal, replacement, or extended downtime) makes the interim untenable sooner.

At promotion, a follow-on ADR (or amendment to this one) confirms the probe design.
