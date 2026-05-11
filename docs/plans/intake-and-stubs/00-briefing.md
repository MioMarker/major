# Briefing — complete the stubbed Tachikoma phases, then wire intake

Audience: a fresh AI session picking this up cold. Scope: three phases, ordered.

---

## Step 0 — Load context (mandatory)

Run the **`major-deep-dive`** skill before doing anything else. It loads `AGENTS.md`, `SPEC.md`, `docs/CONTEXT.md`, `docs/runbook.md`, `docs/failure-modes.md`, and every ADR (~1,200 lines). The work below spans most of Major's surface; paying the upfront context cost beats discovering each piece on demand. Do not start any phase before this is loaded.

---

## Where you're coming in (state on 2026-05-10)

The execution loop is solid end-to-end and was exercised on real workloads today:

- Brief lifecycle: `ready-for-agent` → claim → implementer → reviewer → finalize → PR-merge → `done`
- ADR 009 sandbox hook (recent fix: PR #48), ADR 012 disposition rules (PR #50), prompt rename (PR #51), Telemetry tab UI (PR #53), Re-arm button (PR #55), Dockerfile env fix (PR #56)

The intake side is not wired. That is what this plan addresses, after first promoting two stubbed Tachikoma roles to first-class.

Open follow-ups that intersect this work — read but don't auto-fix:

- Issue **#52** — `major-github-webhook` receipt parser matches anywhere in body. Will affect Phase 3 (issue-event handling).
- Issue **#24** — reviewer-phase metrics not in `runs.*`. Touches Phase 1 / Phase 2 telemetry shape.
- Issue **#29** — Telemetry tab cancelled-cell styling. Cosmetic; defer.
- ADR 012 follow-on (retry budget, deferred). Phase 2 (Repair) is the natural place to revisit.

---

## Phase 1 — Promote Planner from stub to first-class Phase 0

**Goal.** `runPlanner → runImplementer → runReviewer` becomes the Shell pipeline, gated by Brief classification (start narrow). Planner output becomes input to the implementer's context.

**Why now.** The stub has been sitting in `shell/prompts/planner.md` since v1; promoting it unblocks better outcomes on multi-step Briefs and is the structural prerequisite for Phase 3 (Triage decomposes intent → Briefs; Planner decomposes one Brief → an implementation plan — they are not the same).

**Hooks.**

- `shell/prompts/planner.md` (61 lines) — already states the trust-boundary, inputs, "skeleton when wired" section. Read it; the contract is mostly defined. Bump `PLANNER_PROMPT_VERSION` per AGENTS.md hard rule #7 on any edit.
- `shell/main.ts:438` — `executeRun` is where the new `runPlanner` call slots in, before `runSandboxAgent({ role: "implementer", ... })`.
- `shell/tachikoma.ts` — already supports `role: "planner"` per `PROMPT_VERSION_BY_ROLE`. Verify the role-to-prompt-file resolution works for planner.
- New verification check: `tachikoma-planner` (mirrors `tachikoma-implementer` shape).

**Decisions to confirm with the user before implementing.**

1. **Gate:** Run Planner on every Brief, or only on `epic` / `parent` / multi-`expected_paths` Briefs? Default recommendation: gate on classifications-or-multi-path; ship cheap first, broaden after data.
2. **Output contract:** Does Planner produce a structured plan (JSON list of steps) the implementer reads, or just a Markdown plan written to `/work/.major/plan.md`? The prompt's "skeleton" section is silent on shape. **This is decision-class — propose an ADR before coding.**
3. **Required vs advisory:** Is `tachikoma-planner` a required verification (failure parks the Brief) or advisory (failure logs but implementer still runs)? Default: advisory in v1, promote later.

**Exit criteria.**

- `runPlanner` runs before `runImplementer` for Briefs matching the gate; outputs an artifact the implementer prompt reads.
- `tachikoma-planner` verification appears in `verification_results` per Run.
- Telemetry-tab renderer (added in PR #53) handles a new `planner@<date>` `promptVersion` cleanly.
- One real test Brief end-to-end with Planner-on; observe that the implementer's first turn references the plan.

**Slice as 2-3 PRs.** ADR (decision #2) → minimal wiring with Markdown output → gating + advisory verification.

---

## Phase 2 — Promote Repair from stub to wired

**Goal.** A failed Brief at `ready-for-human` can be re-armed *with failure context* such that a subsequent Run is a Repair Run, not a fresh implementer Run.

**Why now (and why after Planner).** Repair's value is conditional on having a clean retry semantics. ADR 012 explicitly defers a budgeted retry; this is the place to design and ship it. Phase 1 (Planner) is independent and lighter, so Phase 2 lands second.

**Hooks.**

- `shell/prompts/repair.md` (165 lines) — read fully; this prompt is more developed than Planner's.
- `shell/main.ts` — `executeRun` would branch on `claim.run.purpose` (the schema already supports `purpose: 'execute' | 'repair' | 'triage'` per `db/types.ts`). Implementer path already handles `execute`; Repair would be a sibling.
- `major-claim-brief` — likely needs to know to issue a Repair Run when the Brief is being re-armed *as a repair*. New flag on the re-arm path.
- The Re-arm button (PR #55) currently always re-arms as a fresh execute Run. Adding a "Re-arm as Repair" option (or detecting a prior failed Run and defaulting to Repair) is the UI surface.

**Decisions to confirm with the user before implementing.**

1. **Retry budget shape.** Per ADR 012 follow-on: per-Brief cap? Reset on Content revision? Counter on `runs.attempt_number`? **Decision-class — write the retry-budget ADR (number 013 or later).** The trigger criterion ADR 012 named ("≥3 Briefs/week where human re-arm produced a second-Run success") may not have data yet; revisit.
2. **Auto vs manual.** Does Repair only fire when a human clicks "Re-arm as Repair", or does the Shell auto-attempt Repair when an `agent-running` Run fails AND the Brief is below its retry budget?
3. **Inputs.** What does the Repair Tachikoma get beyond the Brief snapshot? Last failed Run's transcript? Verification payloads? The branch state?

**Exit criteria.**

- A Brief with one failed `execute` Run can be transitioned back to `ready-for-agent` with a `purpose=repair` claim flag.
- Shell's `executeRun` branches to `runRepair` for those claims.
- New `tachikoma-repair` verification recorded.
- Re-arm UI exposes the choice cleanly (or hides it if auto-Repair is the chosen design).

**Slice as 3-4 PRs.** Retry-budget ADR → schema additions (`runs.attempt_number`, maybe `briefs.max_attempts`) → Shell branch + Repair invocation → UI affordance.

---

## Phase 3 — Wire the Triage Session intake flow

**Goal.** A GitHub issue arriving on a watched repo flows through Triage to produce one or more Briefs, automatically when the path-blocker rule allows, queued for human apply when it doesn't.

**Why this is mostly wiring, not greenfield.** The pieces already exist:

- `supabase/functions/major-create-triage-session/` — entry point
- `supabase/functions/major-start-auto-triage/` — kicks off the Triage Tachikoma Run
- `supabase/functions/major-finalize-triage-session/` — closes the session and applies the Change Set
- `supabase/functions/major-apply-change-set/` — atomic apply of Change Operations
- `supabase/functions/_shared/path_blocker.ts` — auto-vs-human-apply decision
- `shell/prompts/triage.md` (171 lines) — Triage Tachikoma prompt is the most developed of the three stubbed prompts
- `ui/app/triage/[sessionId]/page.tsx` — session-detail UI exists

What's missing is the **trigger** (issue webhook → `major-create-triage-session`) and verification that each piece works end-to-end.

**Sub-phases.**

### 3a — Issue webhook handler

- Extend `supabase/functions/major-github-webhook/index.ts` to handle `issues` events alongside the existing `pull_request` and `check_run` handlers.
- On `issues.opened` (and `issues.edited` from a labeled state, TBD), POST to `major-create-triage-session` with the issue body as the initial Brief content seed and `source_issue_repo` + `source_issue_number` populated.
- This intersects with **issue #52** — webhook regex tightening. Decide order: fix #52 first (smaller, lower risk) so the issue handler benefits from the tightened parser.
- Memory says **ADR 010** is planned but not written — write it in this sub-phase. It defines what fields seed the Triage Session, which issue events trigger, and how labels gate (e.g. `needs-triage` label opt-in).

### 3b — Triage Tachikoma execution

- Confirm `major-start-auto-triage` actually invokes the Triage Tachikoma in a Shell. The function exists but its claim semantics may differ from `major-claim-brief` — read the code and verify.
- `runs.purpose = 'triage'` already exists in the schema. Shell's `executeRun` may need a triage branch (sibling to the upcoming Repair branch from Phase 2).
- The Triage Tachikoma's output is a `triage-change-set` artifact (per `expected_artifact_type` enum). Confirm the artifact type is enumerated and the contract for Change Operations is locked.

### 3c — Change Set apply + path-blocker

- `major-apply-change-set` already exists. End-to-end test it: feed it a synthetic Change Set, verify Briefs are created, verify path-blocker queues human-apply correctly when `expected_paths` intersects protected globs.
- `_shared/path_blocker.ts` already exists. Verify it matches SPEC's mass-rerank threshold (Change Sets touching > 5 Briefs' `queue_rank` go to human apply).

### 3d — Outbound Brief → issue sync (ADR 011)

- Memory says **ADR 011** is planned. Write it.
- On `Brief.status` transitions to `done` / `wontfix`, post a comment on the source GitHub issue with the resolution. ADR 007's auto-close webhook already closes the source issue on `done`; ADR 011 broadens that to mid-lifecycle status posts.
- Consider whether to comment on every status change (noisy) or only the terminal ones (probably the right answer).

### 3e — UI polish for the session-detail surface

- `/triage/[sessionId]` page exists; verify its data fetch covers the just-implemented fields (issue source, change set state, path-blocker decision badge).
- Add a "human apply" button for Change Sets that the path-blocker queued.

**Decisions to confirm with the user before implementing.**

1. **Opt-in vs opt-out.** Does every issue trigger Triage, or only labeled issues (`needs-triage`)? Default recommendation: opt-in via label for v1; broaden after dogfooding.
2. **Repo allowlist.** Which repos are watched? Just `MioMarker/major`, or also `MioMarker/healthbite` and `MioMarker/healix`? The webhook registration list per `runbook §1.6` (extended in PR #38) is the source of truth.
3. **Issue authorship.** Is a human-authored issue the only triage source, or do agent-authored issues count (e.g. a Run that surfaces a follow-up)? Trust-boundary question.
4. **Brief Content Revision authorship.** When Triage creates a Brief, the initial Content Revision's `author_actor` should be `agent:triage-tachikoma:<run_id>` not the issue's GitHub author — the agent wrote the Brief, not the human. Confirm.

**Exit criteria.**

- A test issue opened on `MioMarker/major` with the `needs-triage` label results, within ~minute, in a Triage Session row → an Auto Triage Run → a Change Set → one or more Briefs in `ready-for-agent` (or `ready-for-triage` if the path-blocker queued for human).
- `/triage/[sessionId]` shows the full lifecycle for that session.
- ADR 010 + ADR 011 both written and accepted.
- Brief 1's edge case ("work landed via different path") gets a clean disposition path — possibly a "supersedes" relationship rather than a manual override.

**Slice as 5-7 PRs across the sub-phases.** Don't try to land Phase 3 in one PR.

---

## Working principles for this stretch

1. **Read SPEC.md and the relevant ADRs before each phase.** The stubs and partial implementations were written against specific decisions; honor them or write a new ADR.
2. **Decision-class items get an ADR and a stop.** Per AGENTS.md: "If the question is decision-class (alters architecture), draft an ADR and stop. Don't ship a decision via implementation." Phase 1 decision #2, Phase 2 decision #1, and the ADR 010 / ADR 011 work are all decision-class.
3. **Prompt edits bump the version constant.** AGENTS.md hard rule #7.
4. **Each new edge function needs a `verify_jwt` entry in `supabase/config.toml`.** Match the gateway pattern of the existing functions (mostly `verify_jwt = false`; auth enforced inside the handler via `_shared/auth.ts`).
5. **Prefer many small PRs over fewer big ones.** Each phase is sliced for a reason; respect it.
6. **The Cyberbrain is authoritative.** AGENTS.md hard rule #1 — don't shortcut state from GitHub or files.
7. **If you find scope creep, stop and ask.** This plan is a briefing, not a contract. The user is reviewing PRs and is reachable for clarification.
8. **Cost reporting.** When quoting Run costs, the `costUSD` field is Anthropic API list-price equivalent. Shells run on `CLAUDE_CODE_OAUTH_TOKEN` (Max subscription) so actual out-of-pocket is $0; what's spent is rate-limit budget. Frame numbers as "equivalent API compute" not literal dollars.

---

## What "done" looks like for the whole plan

- All three Tachikoma phases (planner, repair, triage) are wired and run on real workloads at least once.
- A GitHub issue → Triage Session → Brief → execute Run → PR → merge → `done` flow works end-to-end without manual SQL or curl.
- ADRs 010, 011, 013 (or whatever the retry-budget number ends up being) are written and accepted.
- The "Bottom line: execution loop is solid; intake side is manual" framing in `docs/plans/intake-and-stubs/` flips to "intake works".

When that lands, Major has its v1 fundamentals.
