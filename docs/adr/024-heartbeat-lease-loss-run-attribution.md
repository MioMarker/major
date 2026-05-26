# 024. Heartbeat lease-loss must be attributed to the Run it was sent for (fix #180)

## Status

`Accepted`

Date: 2026-05-26

## Context

Bug #180 ("hung/unreapable Tachikoma") has recurred repeatedly: a freshly-claimed
Run aborts seconds into its first phase with `heartbeat: renewedRun=false — lease
lost; setting abort flag`, even though the Run's lease is healthy and keeps
renewing. The Shell then either wedges or self-heals by re-arming
(`cancelled → execute`), wasting a full claim+sandbox cycle each time.

The lease-loss handling was added as finding **F-10** (see ADR 019 § Forces:
"the Shell ignores `renewedRun=false` from heartbeat … Once F-10 is fixed the
lease length becomes load-bearing"). F-10 shipped in `shell/main.ts::callHeartbeat`:

```ts
const body: { shellId: string; runId?: number } = { shellId: env.shellId };
if (activeRun?.runId) body.runId = activeRun.runId;        // (A) read
const resp = await majorApiPost("major-heartbeat", body);  // (B) await — yields
if (activeRun && resp && resp.renewedRun === false) {      // (C) re-read activeRun
  leaseLostFlag = true;
}
```

### Root cause — a time-of-check/time-of-use race

`callHeartbeat` is fired every 30s by a background `setInterval` (and again inside
the CI-wait poll loop). It reads `activeRun` at (A), `await`s a network round-trip
at (B), then re-reads the **module-global** `activeRun` at (C) to decide whether to
set the sticky `leaseLostFlag`. The flag-set at (C) is **not attributed to the Run
the heartbeat was actually sent for.** Two concrete failure shapes:

1. **Idle-heartbeat contamination (the observed #180).** While the Shell idles
   between Briefs (the `major-claim-brief` 409 poll loop), heartbeats fire with **no
   `runId`**. `major-heartbeat` returns `renewedRun=false` unconditionally when no
   `runId` is supplied (`major-heartbeat/index.ts:55-56`). If such an idle
   heartbeat's response lands during (B) — right after the Shell claims a new Brief
   and sets `activeRun` — the check at (C) sees the now-truthy fresh `activeRun` and
   poisons it with `leaseLostFlag = true`. The fresh Run then aborts at its first
   phase boundary.

2. **Stale-prior-Run contamination.** A heartbeat sent for Run N (still in flight at
   (B)) can return `renewedRun=false` legitimately after Run N ends; if Run N+1 is
   claimed during (B), the check at (C) attributes Run N's lease-loss to Run N+1.

Evidence (live, 2026-05-26): Brief 84 Run 10755 was claimed at 04:59:27 on shell-B
(fresh `execute`, lease 05:04:27). At 04:59:35 — 8s in — `renewedRun=false` flipped
the flag, after shell-B had spent the prior ~7 min in the idle 409 poll loop. The
Run's lease kept renewing (heartbeat_at advanced to 05:00:57), proving the Run was
healthy; the lease-loss signal was stale. 10755 aborted at the planner boundary,
Brief 84 re-armed, and Run 10756 repeated the pattern.

The `leaseLostFlag` is module-global and only reset at Run cleanup
(`main.ts` finally block), so a single spurious set reliably aborts the current Run.

## Decision

**A `renewedRun=false` response may set `leaseLostFlag` only when it can be
attributed to the Run that is still active.** `callHeartbeat` captures the `runId`
it sent at (A) and, after the `await`, sets the flag only if **both**:

1. a `runId` was actually sent (`heartbeatRunId != null`) — idle heartbeats can
   never abort a Run; and
2. the current `activeRun?.runId` still equals the `runId` that was heartbeated —
   a Run transition during the `await` must not let a stale response contaminate
   the new Run.

Genuine lease loss on the *current* Run is unaffected: the Reaper cancels Run X,
the heartbeat for Run X returns `renewedRun=false`, `activeRun.runId === X`, and the
flag is set — the Shell aborts at the next phase boundary exactly as F-10 intended.

This is a Shell-side correctness fix to the lease/heartbeat handling. Per
`.claude/rules/shell/sandbox-discipline.md` (Heartbeat Fidelity), lease/heartbeat
changes are ADR-gated; this ADR is the gate. The **lease duration (300s) and
cadence (30s) are unchanged** (ADR 019 stands).

### Alternatives considered

1. **Attribute the flag to the sent `runId` (chosen).** Minimal, local to
   `callHeartbeat`, no API/schema change. Closes both race shapes.
2. **Make `major-heartbeat` return `renewedRun=true` (or a distinct sentinel) when
   no `runId` is supplied.** Removes failure shape (1) but not (2) — an in-flight
   heartbeat for a *prior* Run can still return a legitimate `false`. Also an API
   change requiring an edge-function deploy. Rejected as insufficient and heavier.
3. **Reset `leaseLostFlag` at Run start as well as cleanup.** Narrows the window but
   does not close it: the poisoning heartbeat in shape (1) lands *after* the new Run
   starts. Rejected as a partial fix.
4. **Serialize heartbeats / cancel in-flight ones on Run transition.** Over-engineered
   for v1; the attribution guard achieves the same guarantee far more simply.

## Consequences

**Positive:**
- The dominant #180 manifestation (idle-heartbeat poisoning a fresh Run) is
  eliminated. Fresh `execute` Runs stop aborting spuriously seconds after claim.
- No API, schema, or deploy-coupling change — Shell-only, ships with the next Shell
  image build.
- Genuine Reaper-driven lease loss on the active Run still aborts correctly; the
  F-10 guarantee is preserved, now correctly attributed.

**Negative / trade-offs:**
- If a heartbeat for the current Run is genuinely lost *and* the Run ends and a new
  Run is claimed within the same ~sub-second `await` window, the lease-loss is
  dropped rather than mis-applied. This is correct (the signal was for a Run that no
  longer exists) and the Reaper remains the backstop for the new Run.

**Follow-on work:**
- Consider promoting `leaseLostFlag` from a module-global boolean to a field on
  `ActiveRunState` so attribution is structural rather than a compared id. Deferred —
  the guard added here is sufficient and lower-risk for v1.
