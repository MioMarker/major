# Plan 001 — End-to-End Reliability Fixes

**Status:** Drafted 2026-05-09. Not started. Awaiting decisions in §2.
**Goal:** Close the gaps between SPEC and implementation along the Brief lifecycle (creation → PR → merged) so the system runs reliably end-to-end.
**Audience:** This plan is meant to be picked up by an agent (or a coordinated set of agents) and executed against the repo. Each work stream is independently grabbable; sequencing is in §4.

## Naming note

A naming migration is in flight per `docs/adr/004-ghost-in-the-shell-naming.md`:
- **Brief** = durable unit of intent (was: Work Item). Table: `major.briefs` (was `major.work_items`).
- **Shell** = persistent Docker container (was: Runner / Runner Instance). Code at `shell/` (was `runner/`).
- **Cyberbrain** = Major's authoritative state (was: Workflow Store / DB). Schema: `major.*`.
- **Tachikoma** = ephemeral Claude Code subprocess inside a Shell (unchanged).

Where this plan references file paths or table names, follow the on-disk reality at the time you pick it up. If the rename has landed, use the new names; if not, use the old. Use the new vocabulary in any prose you write.

---

## 1. Background

A full e2e audit on 2026-05-09 traced creation → triage → claim → run → PR → merge against `SPEC.md`, `docs/CONTEXT.md`, `docs/failure-modes.md`, the migrations, all 13 edge functions, both RPCs, the Shell main loop, and the Tachikoma harness. The audit surfaced ~25 distinct issues; about a third are **P0** (would prevent or corrupt the e2e flow today). The full catalogue is in §5.

The fix scope is too large for a single PR but is naturally partitionable into 5 streams that share little code. This plan partitions the work, sequences it to avoid stepping on shared files, and pins the cross-cutting decisions that must be made before code lands.

## 2. Open architectural decisions

These must be resolved (recorded as ADRs) **before** any stream starts. Each decision unblocks one or more streams.

| # | Decision | Default recommendation | Blocks |
|---|---|---|---|
| D1 | Triage Change Operation payload casing: snake_case (matches SQL) or camelCase (matches TS conventions)? | snake_case in the JSONB payload; camelCase only on TS interfaces that are converted at the edge | Stream A, B, C |
| D2 | Lease length: keep the current 5-minute default and update `.claude/rules/shell/sandbox-discipline.md`, or shorten to the 90s the rule already specifies? | Keep 5 minutes; rewrite the rule. Heartbeat stays at 30s. The 90s figure was aspirational; 5 min is what's been operating. | Stream B, D |
| D3 | Test framework split: pgTAP for RPCs + Deno test for edge functions + Vitest for Shell, or one tool everywhere? | Use the natural per-runtime tool: pgTAP for RPCs, Deno test for functions, Vitest for Shell. Add a single `npm test` aggregator. | Stream E |
| D4 | PR Derived Facts storage: JSONB column on `briefs` vs. new `pull_requests` table? | JSONB column `pr_derived_facts` on `major.briefs` for v1; lift to a table later if/when we query the facts relationally. | Stream A, C |

Each decision becomes a one-page ADR (`docs/adr/00X-*.md`) before its blocked streams begin.

## 3. Work streams

Five streams. Each owns disjoint files (with the exception of the `db/types.ts` ↔ `rpc_functions.sql` boundary that A and B share — A lands first to set the contract). Each stream lands as one PR to `dev`. Author cannot self-approve; the other dev (or an `/ultrareview` pass) must approve before merge.

### Stream A — Cyberbrain schema + types

**Owns:** `supabase/migrations/<new>.sql`, `db/types.ts`.
**Depends on:** D1, D4.
**Branch:** `feat/cyberbrain-schema-alignment`.

Tasks:

1. New migration adding `pr_derived_facts JSONB NOT NULL DEFAULT '{}'` on `major.briefs` (per D4). Include columns / mappings for: mergeable, ci_status_rollup, approvals_count, requested_changes_count, branch_protection_state, conflicts_known.
2. New migration adding the failure-mode-required tables that the rules reference but don't exist:
   - `major.eval_signatures` (per failure-mode #16) — `(workflow_path text, sha text, registered_by text, registered_at timestamptz)`.
   - `major.shell_pool_state` (per failure-mode #15) — singleton table with `paused boolean, paused_reason text, updated_at timestamptz, updated_by text`.
3. New migration adding a transition-allowlist CHECK to `major.briefs` that codifies the SPEC lifecycle state machine (or a `major.allowed_transitions` table that the apply RPCs join against — see §5 finding F-25 for context).
4. Update `db/types.ts` to:
   - Resolve D1 payload casing across `TriageChangeOperationPayload`. Whichever casing wins, **the TS shape and the JSONB field names the RPCs read MUST agree**.
   - Add `Brief['prDerivedFacts']` and types for the two new tables.
   - Update string-literal unions if any new event/observation types are added.
5. Update `db/types.smoke.ts` to exercise the new shapes.

**Definition of done:** migrations dry-run cleanly; types compile; smoke test passes; no consumer of `db/types.ts` is left referencing dropped fields.

### Stream B — RPC correctness + atomicity

**Owns:** `supabase/migrations/<new>_rpc_v2.sql` (a new migration that `CREATE OR REPLACE`s the affected functions).
**Depends on:** Stream A merged (so the payload contract from D1 is live).
**Branch:** `feat/rpc-atomicity-fixes`.

Tasks:

1. **`finalize_run`:**
   - Add ownership + state guard to the first UPDATE: `update major.runs set outcome = p_outcome, ... where id = p_run_id and outcome = 'running' and runner_id = p_caller_runner_id` (add caller param). Bail with a clear exception when 0 rows.
   - Add `ON CONFLICT (idempotency_key) DO NOTHING` to every event insert in this RPC (currently silent retries throw on the unique constraint). Mirror the `reaper_sweep` pattern.
   - Add a unique key for `major.brief_artifacts` in Stream A (`(run_id, artifact_type, external_ref)` partial unique where `external_ref is not null`) and `ON CONFLICT DO NOTHING` here.
   - Validate `p_next_status` against the SPEC transition matrix (per Stream A task 3).
2. **`claim_next_brief`:**
   - Add Shell-passed idempotency key validation: if a Run with the same `(runner_id, idempotency_key)` already exists, return that Run instead of claiming a new Brief (closes orphan-on-retry from finding F-08).
   - Skip Briefs that have an `auto_triage_requests` row in `requested` or `running` status (closes finding F-10).
   - Optionally check `git_repository_ref` is non-null and in a known repo allowlist; defer artifact-contract support check (deferred per CUTS).
3. **`apply_change_set`:**
   - Re-key payload reads to whichever casing D1 picked. Audit every `v_payload->>'…'` site.
   - Validate every `transition-work-item` and `set-ready-state` against the transition matrix.
   - For `set-ready-state(true)` and `transition-work-item(to=ready-for-agent)`, run the path-blocker server-side using the target Brief's existing `expected_paths` (this is the Stream B half of finding F-04; the edge-function half is in Stream C).
4. **`reaper_sweep`:** verify it's still correct after the above changes; no edits expected.

**Definition of done:** all 4 RPCs can be re-invoked safely; pgTAP suite from Stream E covers each ownership/idempotency path; manual replay of a finalize call is a no-op; manual concurrent-claim attempt loses cleanly.

### Stream C — Edge functions

**Owns:** every directory under `supabase/functions/major-*/` plus `supabase/functions/_shared/path_blocker.ts`.
**Depends on:** Stream A merged.
**Branch:** `feat/edge-function-hardening`.

Tasks:

1. **`major-finalize-triage-session`:** rewrite the path-blocker aggregator (`index.ts:86-96`) to pull `expected_paths` from the target Brief for every transition op (covers finding F-04).
2. **`major-confirm-qa`:** add `eq("pr_status", "merged")` to the conditional UPDATE so the human can't confirm QA on an unmerged PR (finding F-21).
3. **Idempotency keys** in `major-confirm-qa`, `major-reject-brief`: drop `Date.now()` from the delivery key. Use a stable key like `qa-confirm:<briefId>` / `reject:<briefId>:<actor>` so replays no-op (findings F-02, F-23).
4. **`major-claim-brief`:** generate and pass the idempotency key for Stream B's new contract. Stable across retries within a single Shell-side claim attempt.
5. **`major-github-webhook`:**
   - Capture and persist Pull Request Derived Facts from `pull_request` events into `briefs.pr_derived_facts` (mergeable, requested_reviewers, etc.). Closes finding F-19.
   - Add `tachikoma-implementer` to `KNOWN_CHECK_NAMES`.
   - Emit a Telemetry Record when a PR with no `Major-item:` receipt arrives.
6. **Error redaction:** every catch block currently passes raw `error.message` to the client (`return errorResponse(error.message, 500)`). Replace with a generic message + console-log of the detailed error. Per `.claude/rules/common/security.md`.
7. **Lease length:** if D2 keeps 5 minutes, no code change but update `.claude/rules/shell/sandbox-discipline.md` to match. If D2 picks 90s, change defaults in `major-claim-brief/index.ts` and `major-heartbeat/index.ts` and the Shell heartbeat cadence.

**Definition of done:** Deno test suite from Stream E passes; webhook integration test confirms derived facts land on the Brief; manual QA-confirm attempt before PR merge returns 409.

### Stream D — Shell daemon + Tachikoma harness

**Owns:** `shell/` (or `runner/` if rename hasn't landed). Specifically `main.ts`, `tachikoma.ts`, `Dockerfile`.
**Depends on:** Stream B merged (heartbeat contract).
**Branch:** `feat/shell-graceful-abort`.

Tasks:

1. **Heartbeat-loss abort:** `callHeartbeat` currently discards the response (`main.ts:130-135`). Inspect `renewedRun`; if `false`, set a module-level `leaseLostFlag` and abort the active Run at the next safe boundary (between phases, between CI poll iterations). Closes failure mode #3 + finding F-13.
2. **Sandbox cleanup:** `cleanupSandbox` (`main.ts:487`) only removes the repo dir. Also remove `/work/.major/` (transcripts, item.json, implementer-output.json, telemetry.jsonl) per `sandbox-discipline.md`. Closes finding F-15.
3. **Token leak:** stop baking `GITHUB_TOKEN` into the clone URL (`main.ts:452`). Use `git -c http.extraheader="Authorization: Bearer $TOKEN"` or a credential helper so the token doesn't land in `.git/config`. Closes finding F-16.
4. **PR-already-exists handling:** when the Tachikoma re-runs against a Brief whose branch already has a PR, the `gh pr create` call fails. Either surface a structured signal in the implementer prompt's output schema (`pr_already_exists: true, pr_url, pr_number`) and have the Shell treat that as success, or have the Shell pre-check via `gh pr list --head major/brief-<id>` before invoking the Tachikoma.
5. **Auto Triage dispatcher (stub-class, not full):** add a `runTriage` entry that the main loop calls when an `auto_triage_requests` row in `requested` status matches a Brief that's also `ready-for-triage`. Spawns a `purpose='triage'` Run via the same claim path. Out of scope for full triage Tachikoma prompt — that's its own work item — but the dispatcher should exist so the request rows aren't inert (finding F-22).
6. **`__dirname` confirmation:** verify `runner/tachikoma.ts:108` still works in whatever module system the Dockerfile compiles to. If ESM, switch to `import.meta.url` resolution.

**Definition of done:** Vitest suite from Stream E covers the abort path + cleanup path; manual run with a force-killed heartbeat loop confirms the Shell aborts within one heartbeat tick; container restart reuses the same branch without `gh pr create` looping.

### Stream E — Tests

**Owns:** new `tests/` directory layout (or per-package adjacent tests, see D3).
**Depends on:** Streams A/B/C/D landing in any order — tests get written against each as it merges.
**Branch:** `feat/rpc-and-function-tests`.

Tasks:

1. **pgTAP suite for the 4 RPCs:**
   - `claim_next_brief`: empty queue, normal claim, race (two concurrent calls — only one wins), idempotent retry (same key returns same row), skip-blocked, skip-auto-triage.
   - `finalize_run`: happy path, ownership mismatch (slow-runner scenario — must reject), idempotent retry (no-op), invalid `nextStatus` (rejected).
   - `apply_change_set`: each op type's happy path, payload casing per D1, partial-failure rollback, transition-matrix violation (rejected), path-blocker re-check on transitions.
   - `reaper_sweep`: lease-expired sweep, no-op when nothing expired, idempotent re-run.
2. **Deno test for path-blocker:** the glob matcher (already pure), plus the aggregator that should now pull paths from target Briefs.
3. **Deno test for webhook signature verification** + handler smoke (mocked GitHub payloads → assertion on derived facts written).
4. **Vitest for the Shell:** abort-on-lease-loss; sandbox cleanup; PR-exists detection.
5. **One e2e integration test** that walks: create Brief → finalize triage with auto-apply → simulated Shell claim → simulated finalize → simulated PR webhook → confirm QA → status `done`. Run this against a disposable schema in the dev project (or a local Postgres if the team wants to set one up — out of scope to introduce).
6. **CI hookup:** GitHub Actions workflow that runs the suites on every PR to `dev`. Block merge if red.

**Definition of done:** every P0 finding from §5 has at least one regression test; CI is green on `dev` HEAD after all four code streams merge.

## 4. Sequencing

```
Decisions (D1–D4, four short ADRs)         ← do this first; ~1 hour
        ↓
Stream A (schema + types)                   ← solo; everything else depends on it
        ↓
        ├── Stream B (RPCs)                 ← parallel
        ├── Stream C (edge functions)       ← parallel
        └── Stream D (Shell)                ← parallel; depends on B's heartbeat contract
                ↓
Stream E (tests)                            ← incrementally, against each merged stream
```

Streams B/C/D can each be one agent in a worktree (`isolation: "worktree"` per `.claude/rules/common/git-workflow.md`). Each PR to `dev` requires the second dev's review.

## 5. Findings catalogue (audit reference)

Severity: 🔴 P0 = breaks or corrupts the e2e flow today. 🟡 P1 = reliability / spec drift. 🟢 P2 = nice to have.

### Triage

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-01 | 🔴 | Triage Tachikoma is a stub (`major-send-triage-message` has TODO; no real LLM call). | (out of scope; tracked separately) |
| F-02 | 🟡 | `major-confirm-qa` and `major-reject-brief` mix `Date.now()` into idempotency keys → retries duplicate Events. | C |

### Triage Change Set + Path-blocker

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-03 | 🔴 | Payload casing mismatch between `db/types.ts` (camelCase) and `apply_change_set` RPC (snake_case) → all change ops silently null. | A + B |
| F-04 | 🔴 | Path-blocker only inspects `expected_paths` from `create-item`. Transitions and `set-ready-state` ops bypass the blocker entirely. | B + C |
| F-05 | 🟡 | `major-apply-change-set` doesn't re-run the path-blocker (trusts human). Defensible but worth a comment. | C |

### Run Start (Claim)

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-06 | 🔴 | `major-claim-brief` idempotency key includes `crypto.randomUUID()` → orphan Run on retry. | B + C |
| F-07 | 🟡 | `claim_next_brief` doesn't skip Briefs with active Auto Triage Requests. | B |
| F-08 | 🟡 | `claim_next_brief` doesn't check artifact contract / repo accessibility. | B (partial) |
| F-09 | 🟡 | Lease length divergence: code 5 min, rule 90s. | D2 decision |

### During the Run

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-10 | 🔴 | Shell ignores `renewedRun=false` from heartbeat → no graceful abort. | D |
| F-11 | 🔴 | `finalize_run` RPC has no ownership / state check → slow-runner can corrupt re-claimed Runs. | B |
| F-12 | 🟡 | `finalize_run` event inserts lack `ON CONFLICT DO NOTHING` → genuine retries throw on unique key. | B |
| F-13 | 🟡 | `finalize_run` artifact inserts have no dedup. | A (unique key) + B (ON CONFLICT) |
| F-14 | 🟡 | Sandbox cleanup leaves `/work/.major/` between Briefs. | D |
| F-15 | 🟡 | `GITHUB_TOKEN` baked into clone URL → ends up in `.git/config`. | D |
| F-16 | 🟡 | Re-running a Brief whose PR already exists → `gh pr create` failure loop. | D |

### PR Webhook + CI

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-17 | 🔴 | Pull Request Derived Facts not persisted; UI cannot show `needs-rebase` / `ci-pending` badges. | A + C |
| F-18 | 🟡 | Failure-mode tables `eval_signatures` and `shell_pool_state` referenced but missing. | A |

### Acceptance

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-19 | 🟡 | `major-confirm-qa` doesn't check `pr_status='merged'`. | C |

### Unimplemented surfaces

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-20 | 🟡 | `major-start-auto-triage` writes rows; nothing reads them. | D (dispatcher only) |
| F-21 | 🟡 | `repair-inspection-trigger` Telemetry Records have no consumer. | (out of scope) |
| F-22 | 🟢 | `apply_change_set` and `finalize_run` don't validate transitions against the lifecycle. | A (table) + B (use it) |

### Cross-cutting

| # | Sev | Finding | Stream |
|---|---|---|---|
| F-23 | 🔴 | No automated tests on lifecycle-mutating code. | E |
| F-24 | 🟡 | Edge functions return raw `error.message` to clients. | C |

## 6. Definition of done (whole plan)

- All four ADRs from §2 merged.
- All four code streams (A, B, C, D) merged to `dev` with two-dev approval.
- Stream E delivers a green test suite covering every P0 finding; CI gates `dev`.
- A manual e2e walkthrough (create Brief → triage → claim → run → PR → merge → QA confirm → `done`) succeeds without operator intervention.
- The audit findings catalogue (§5) is updated in this file with each finding marked `RESOLVED <commit-sha>` or `DEFERRED <reason>`.

When done: archive this file under `docs/plans/done/001-e2e-reliability-fixes.md` and reference the resulting commits + PRs in the archive header.
