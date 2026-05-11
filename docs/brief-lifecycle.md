# Brief Lifecycle Reference

Quick reference for what each Brief Status means and what action (if any) it expects from you.

Full lifecycle spec in `SPEC.md § Lifecycle state machine`. Failure recovery in `failure-modes.md`. Day-to-day workflow in `user-guide.md`.

---

## Status reference

| Status | Meaning | Your action |
|---|---|---|
| `ready-for-triage` | Brief created; path-blocker hasn't evaluated it yet, or the Change Set is waiting for manual apply | None — auto-transitions to `ready-for-agent` if path-blocker passes. If it needs human apply, see the **Needs Human Apply** badge in Briefs View. |
| `needs-info` | Triage Session flagged that the PRD is missing required information | Supply the missing info in the Triage Session; a new Content Revision re-routes the Brief back to `ready-for-triage`. |
| `ready-for-agent` | In queue; waiting for a Shell to claim it | None — Shells self-select in ascending `queue_rank` order. If nothing is happening, check that at least one Shell is running and healthy. |
| `agent-running` | A Shell holds an active Run — implementer + reviewer Tachikoma phases are in progress | None. Monitor via Brief Detail → Runs tab if curious. Heartbeat renews every 30 s; lease expires after 90 s without a heartbeat. |
| `ready-for-review` | Run succeeded — PR is open, reviewer Tachikoma has posted comments | **Review and QA-confirm (or reject).** Go to Pending QA, open the PR, review the diff, then click QA Confirmed or Reject. |
| `ready-for-human` | A Run failed or was parked; needs human decision before next attempt | **Diagnose, then act.** See `user-guide.md §4` for the decision tree. Options: Re-arm (simple retry), add more PRD detail via Triage (then Brief auto-routes back), take over the branch manually, or Reject. |
| `done` | Accepted — PR merged, work shipped | Terminal. Source GitHub issue closed if one was linked. |
| `wontfix` | Rejected — will not be implemented | Terminal. PR closed if one existed. |

---

## Transition authority

Who can trigger each transition:

| Transition | Who |
|---|---|
| (create) → `ready-for-triage` | You (via Triage Session apply) |
| `ready-for-triage` → `ready-for-agent` | Auto (path-blocker passes) or you (manual apply) |
| `ready-for-triage` → `needs-info` | Triage AI |
| `needs-info` → `ready-for-triage` | You (new Content Revision via Triage) |
| `ready-for-agent` → `agent-running` | Shell (Run Start Transaction — atomic) |
| `agent-running` → `ready-for-review` | Shell (Run Finalization — CI green + PR open) |
| `agent-running` → `ready-for-human` | Shell (Run Finalization — failed) or you (Human Run Cancellation) |
| `agent-running` → `ready-for-agent` | Reaper (lease expired — clean retry) |
| `ready-for-human` → `ready-for-agent` | You (Re-arm button) |
| `ready-for-review` → `done` | You (QA Confirmed) or PR-merge webhook (GitHub merger) |
| `ready-for-review` → `wontfix` | You (Reject) or PR-closed webhook (GitHub closer) |
| `ready-for-human` → `done` / `wontfix` | PR-merge / PR-closed webhook (if the branch's PR was acted on directly) |
| any non-terminal → `wontfix` | You (Reject button in Brief Detail) |

---

## Brief Detail tabs

| Tab | What it shows |
|---|---|
| **Content** | Current PRD (Brief Content) and full revision history |
| **Events** | Chronological lifecycle Events — every status transition and Run boundary, with Actor attribution |
| **Runs** | All Runs (purpose, outcome, Shell, timestamps) |
| **Verification** | Verification Results per Run — `tsc`, tests, eval gate, reviewer pass; `required` vs advisory |
| **Artifacts** | Produced outputs — PR link (git-change), Triage Change Set (if Auto Triage Run) |
| **Telemetry** | Run-level metrics (turns, tokens, duration), top bash verbs, raw Telemetry Records |
| **Relationships** | Parent/child and blocks/blocked-by edges to other Briefs |

---

## What "Telemetry" vs "Events" means

**Events** are lifecycle-authoritative: every row represents a state transition or Run boundary. The Events tab is the audit trail — who did what and when.

**Telemetry** is observational: per-turn Tachikoma stream data, bash command audit records, token counts. Nothing in the lifecycle reads Telemetry; it exists for diagnosis and cost attribution.

---

## Actions available by status

| Status | Re-arm | Reject | QA Confirm |
|---|---|---|---|
| `ready-for-triage` | — | ✓ | — |
| `needs-info` | — | ✓ | — |
| `ready-for-agent` | — | ✓ | — |
| `agent-running` | — | ✓ (Human Run Cancellation → `ready-for-human`) | — |
| `ready-for-review` | — | ✓ → `wontfix` | ✓ → `done` |
| `ready-for-human` | ✓ → `ready-for-agent` | ✓ → `wontfix` | — |
| `done` | — | — | — |
| `wontfix` | — | — | — |
