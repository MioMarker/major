# Implementation handoff — intake-and-stubs Phases 2 & 3

Audience: a fresh AI session, briefed cold, that will use the `/to-issues` skill to turn this document into independently-grabbable Briefs on the Major queue, then walk away while Major implements them via the AFK loop.

This is the *implementation* counterpart to `00-briefing.md`. The decisions are done; what's left is wiring.

---

## Step 0 — Load context (mandatory)

Read in order:

1. `AGENTS.md` — the 9 hard rules; especially #2 (Content vs Metadata), #5 (path-blocker non-optional), #6 (idempotency keys), #7 (prompt versioning).
2. `SPEC.md` — primitives, lifecycle, schema.
3. `docs/CONTEXT.md` — domain vocabulary.
4. `docs/plans/intake-and-stubs/00-briefing.md` — the parent plan.
5. The four ADRs implementation hangs on:
   - `docs/adr/007-auto-close-brief-and-issue-on-pr-terminal.md` — auto-close mechanic ADR 011 extends.
   - `docs/adr/010-inbound-github-issue-to-triage-session.md` — inbound flow.
   - `docs/adr/011-outbound-brief-to-issue-resolution-comment.md` — outbound flow.
   - `docs/adr/014-run-retry-budget.md` — Repair phase + retry budget.
6. `.claude/rules/` — auto-loaded by your runtime as relevant paths are edited.

If `major-deep-dive` skill is available, run it.

---

## Where we're coming in (state on 2026-05-10 evening)

`dev` carries everything decision-class from this stretch:

- Planner is wired and live (PR #58). Gate is `expectedPaths.length > 1 OR classifications include epic/parent`. Verified end-to-end against Brief 19 (expansion-needed bail path). Unit tests cover gate logic.
- ADR 010 / 011 / 014 all merged. Nothing else is decision-class for this plan.
- `major-shell:latest` runs on shell-A/B/C with the Planner code; restart pattern documented in `docs/runbook.md` §1.7.

What is *not* yet live:

- The inbound trigger that turns `issues.opened`-with-`major:triage`-label into a Triage Session (ADR 010).
- The outbound resolution comment + symmetric `wontfix` issue close (ADR 011).
- The auto-retry below budget + Repair Tachikoma path (ADR 014).

The plan's "Bottom line" still reads "execution loop is solid; intake side is manual." This handoff is what flips it to "intake works."

---

## Strategy

### Bootstrap order

There is one bootstrap dependency:

1. **Issue #1 below (ADR 010 implementation) MUST land first**, manually triaged via the Major UI by the operator, because the auto-ingest channel doesn't exist until it does.
2. After Issue #1 deploys, all subsequent issues can be opened with the `major:triage` label and flow through inbound Triage automatically.

If Issue #1 fails to land for any reason, the operator continues triaging manually via UI for the remaining issues. The plan still completes; the user-friction cost is higher.

### Why this slicing

Each issue below is sized so the Implementer Tachikoma can complete it in one Run. Acceptance criteria are concrete (specific files, specific function names, specific test expectations) so the Tachikoma's first attempt succeeds. `expected_paths` are listed literally so the path-blocker rule fires correctly and the Planner gate decides correctly.

Issues are independently grabbable except where explicitly noted. Multi-Brief-from-one-issue is fine if `/to-issues` slices further; the listing below is the natural minimum-vertical-slice grain.

### What needs the operator

Across the whole sequence:

1. **Merge each PR** as Major opens it (5–8 merges, depending on slicing).
2. **Apply the schema migration once** for Issue #5 (Repair budget). Command in the runbook §1.2. ~30 seconds with the password from 1Password.
3. **Restart the Shell containers** after Issues touching Shell code merge. The deploy-shell pattern is in `runbook.md` §1.7; the agent can also restart them via Docker if granted permission.
4. **Deploy edge functions** after Issues touching `supabase/functions/` merge: `npx -y supabase functions deploy <name>`. The agent can do this if granted.
5. **Apply each issue's `major:triage` label** on creation (except Issue #1 which has no inbound channel yet — needs manual UI triage).

Total operator time: ~15 minutes spread across the plan.

---

## Issues

Each entry below is the seed for a Brief PRD. `/to-issues` should produce one GitHub issue per entry, labeled `major:triage`, against `MioMarker/major`. The Triage Tachikoma will then produce the structured Brief.

### Issue #1 — Inbound: implement ADR 010 (`major-github-webhook` `handleIssue` + `trigger_payload` plumbing)

**Why.** ADR 010 (`docs/adr/010-inbound-github-issue-to-triage-session.md`) is accepted; this issue implements it. Once shipped, every subsequent issue in this plan flows through inbound Triage automatically.

**expected_paths** (literal — these are the only files allowed):
- `supabase/functions/major-github-webhook/index.ts`
- `supabase/functions/major-create-triage-session/index.ts`
- `supabase/functions/major-github-webhook/handle-issue.test.ts` (new — Deno tests for the gate)

**Acceptance criteria.**
1. `major-github-webhook/index.ts` adds a `handleIssue(client, payload, delivery)` branch on `X-GitHub-Event: issues`. The handler:
   - Returns early unless `(action === "opened" && labels include "major:triage") || (action === "labeled" && label.name === "major:triage" && issue.state === "open")`.
   - Returns early unless `sender.type === "User"`.
   - Returns early unless `repository.full_name ∈ {"MioMarker/major","MioMarker/healthbite","MioMarker/healix"}`.
   - Checks `major.triage_sessions` for an existing non-finalized Session keyed on `(trigger_payload->>'source_issue_repo', (trigger_payload->>'source_issue_number')::int)`. Skips if found.
   - POSTs to `major-create-triage-session` (via service-role client) with `entry_point: "integration:github"` and the `trigger_payload` shape specified in ADR 010 §"Seed payload."
2. `major-create-triage-session/index.ts` accepts the new `trigger_payload` field and persists it on the Triage Session row. Passes the payload through to the eventual Auto Triage Run so the Tachikoma prompt can read it.
3. `handle-issue.test.ts` covers (via Deno test):
   - opened-with-label-and-human-sender-and-allowed-repo → triggers
   - opened-without-label → skips
   - opened-with-bot-sender → skips
   - opened-with-disallowed-repo → skips
   - labeled-with-`major:triage`-on-open-issue → triggers
   - labeled-with-different-label → skips
   - opened-twice-same-issue → second call is no-op (idempotency)
   - issue closed → skips
4. `deno check` and `deno test` pass for all touched files.

**Scope boundaries.**
- Does NOT modify `major-apply-change-set` (the agent-attribution for Brief Content is set there, separately — out of scope for this Brief unless tests force it).
- Does NOT add a UI surface to `/triage/`.
- Does NOT touch issue templates in the repo's `.github/`.
- Does NOT change the webhook event registration list — operator confirms the `Issues` event is subscribed per `runbook.md` §1.6 out-of-band.

**Classifications.** `feature`.

**Notes for the Tachikoma.** The existing PR-handler in `index.ts` is the canonical shape to mirror. Idempotency-key derivation lives in `_shared/idempotency.ts`. Service-role client from `_shared/db.ts`. Deno test pattern: `_shared/sanitizer.test.ts` is the closest sibling.

**Bootstrap note.** This issue cannot itself flow through inbound Triage (the inbound channel is what it builds). Operator triages this Brief manually via the Major UI.

---

### Issue #2 — Inbound verification: drop a synthetic Triage Session through the end-to-end flow

**Why.** ADR 010 implementation (Issue #1) is mechanical; the existing downstream (`major-finalize-triage-session`, `major-apply-change-set`, Triage Tachikoma) is presumed working but never exercised end-to-end with the new inbound trigger. This Brief verifies the pipeline.

**expected_paths.**
- `docs/runbook.md` (adds a "Inbound trigger smoke test" section)

**Acceptance criteria.**
1. After Issue #1 is deployed, the operator labels a test issue on `MioMarker/major` with `major:triage`.
2. Within ~60 seconds, a `triage_sessions` row exists with `trigger_payload.source_issue_repo` populated.
3. The Auto Triage Run starts (records appear in `runs` with `purpose='triage'`).
4. The Triage Tachikoma produces a Change Set.
5. The path-blocker auto-applies the Change Set (since the test issue's resulting Brief shouldn't intersect protected globs).
6. A new `briefs` row exists with `source_issue_repo`/`source_issue_number` populated and `author_actor` on its initial Content Revision = `agent:triage-tachikoma:<run_id>`.
7. `docs/runbook.md` gains a new section under Day-to-day operations titled "Inbound trigger smoke test" documenting these 6 checks as a reproducible procedure with SQL queries.

**Scope boundaries.**
- This Brief writes documentation only. If any of the 6 acceptance checks fail, the Tachikoma emits a Telemetry Record describing which check failed and parks the Brief at `ready-for-human` (existing `expected-paths-insufficient`-style bail). A human then files a follow-up issue to fix the broken sub-component.

**Classifications.** `docs` + `bug-fix` (since failure surfaces real bugs in 3b/c wiring).

---

### Issue #3 — Outbound: extract `_shared/github-issue.ts` helper

**Why.** ADR 011 (`docs/adr/011-outbound-brief-to-issue-resolution-comment.md`) calls for a shared helper called by three trigger points. Extract first so the trigger-point Briefs that follow are small refactors.

**expected_paths.**
- `supabase/functions/_shared/github-issue.ts` (new)
- `supabase/functions/_shared/github-issue.test.ts` (new — Deno tests)

**Acceptance criteria.**
1. `_shared/github-issue.ts` exports `postResolutionAndClose(args)` with the exact signature in ADR 011 §"Trigger points":
   ```ts
   {
     issueRepo: string;
     issueNumber: number;
     brief: { id: number; title: string; pr_url: string | null; status: "done" | "wontfix" };
     verificationResults: Array<{ check_name: string; outcome: "pass"|"fail"|"skipped"; required: boolean }>;
     closeReason: "completed" | "not_planned";
     rejectionReason?: string | null;
   } → Promise<{ ok: boolean; error?: string }>
   ```
2. The helper:
   - Renders the comment body per ADR 011 §"Comment body (template)".
   - Checks for an existing comment with the marker `Resolved by Major Brief #<id>` (paginated GET; cap at 100 comments scanned) and skips the post if present (idempotency).
   - POSTs the comment via `POST /repos/{owner}/{repo}/issues/{number}/comments`.
   - PATCHes the issue closed with `{ state: "closed", state_reason: <closeReason> }`.
   - Returns `{ ok: false, error }` on any failure, never throws.
   - Authenticates via `GITHUB_APP_TOKEN` env var (already configured per `runbook.md` §1.7.1).
3. `github-issue.test.ts` covers (mocking `fetch`):
   - done with PR + verifications → comment rendered with all sections, POST + PATCH both called
   - wontfix with rejectionReason → comment rendered with reason, no PR block, POST + PATCH called
   - empty verifications → verification block omitted
   - existing-marker-comment-found → POST skipped, PATCH still called
   - POST fails → returns `{ ok: false, error }`, PATCH not called
   - PATCH fails after POST → returns `{ ok: false, error }`
4. `deno check` and `deno test` pass.

**Scope boundaries.**
- Does NOT modify any of the three callers (`major-github-webhook`, `major-confirm-qa`, `major-reject-brief`). Those are separate Briefs.
- Does NOT add CLAUDE.md or runbook.md updates. Those are operator-runbook Briefs separately.

**Classifications.** `refactor`.

**Notes for the Tachikoma.** Comment template is normative per ADR 011 — render exactly as specified including the rendered samples. Marker scan is the idempotency mechanism; treat it as load-bearing.

---

### Issue #4 — Outbound: wire helper into webhook + UI mutators

**Why.** Three callers replace their inline comment/close logic with the new `_shared/github-issue.ts` helper. ADR 011 §"Trigger points".

**Depends on Issue #3** (helper must exist).

**expected_paths.**
- `supabase/functions/major-github-webhook/index.ts` (`maybeAutoCloseBrief` calls helper; new wontfix branch)
- `supabase/functions/major-confirm-qa/index.ts` (calls helper after status transition)
- `supabase/functions/major-reject-brief/index.ts` (calls helper after status transition)

**Acceptance criteria.**
1. `major-github-webhook/maybeAutoCloseBrief` queries the latest Run's `verification_results` for the Brief, then calls `postResolutionAndClose` with `closeReason: "completed"` (for merged) or `"not_planned"` (for closed-without-merge). The inline comment+close code is removed.
2. `major-confirm-qa` calls `postResolutionAndClose` with `closeReason: "completed"` after the Brief transitions to `done`, gated on `briefs.source_issue_repo IS NOT NULL`.
3. `major-reject-brief` calls `postResolutionAndClose` with `closeReason: "not_planned"` after the Brief transitions to `wontfix`, gated on `briefs.source_issue_repo IS NOT NULL`. Passes the rejection reason (Event payload's `reason` field) as `rejectionReason`.
4. All three callers log a Telemetry Record on `ok: false` from the helper, matching `failure-modes.md` §18 pattern.
5. Existing edge-function tests still pass.
6. New Deno test added per caller covering the happy path (mock `_shared/github-issue.ts`'s `postResolutionAndClose`).

**Scope boundaries.**
- Does NOT change Brief status transition logic — those stay where they are. Only the comment/close side-effect moves.
- Does NOT modify ADR 007 — ADR 011 supersedes the comment body, kept the close mechanic.
- Does NOT update `failure-modes.md` §18 in this Brief; that's a small docs Brief separately.

**Classifications.** `feature`. Multi-path → Planner gate fires.

---

### Issue #5 — Repair: schema migration for retry budget

**Why.** ADR 014 (`docs/adr/014-run-retry-budget.md`) requires `briefs.max_attempts` and `runs.attempt_number`. Schema-only Brief; no behavior change yet (defaults preserve existing behavior).

**expected_paths.**
- `supabase/migrations/20260511000000_run_retry_budget.sql` (new, filename = today's date if 2026-05-11; adjust to actual run date)
- `db/types.ts` (add `max_attempts: number` to `Brief`; add `attempt_number: number` to `Run`)

**Acceptance criteria.**
1. Migration adds:
   - `alter table major.briefs add column max_attempts integer not null default 3;`
   - `alter table major.runs add column attempt_number integer not null default 1;`
2. Migration is wrapped in `begin; ... commit;` per `.claude/rules/db/migrations.md`.
3. Migration file references ADR 014 in a leading comment.
4. `db/types.ts` updated to match.
5. **The migration is NOT applied in this Brief.** Operator applies via `npx -y supabase db push` per `runbook.md` §1.2.

**Scope boundaries.**
- Does NOT modify `major-claim-brief` RPC. That's Issue #6.
- Does NOT modify Shell code. That's Issue #7.
- Does NOT seed any rows. Defaults handle existing rows.

**Classifications.** `feature`.

**Notes for the Tachikoma.** Append-only migration discipline per `db/migrations.md`. Don't edit prior migration files. The filename must use the next monotonic timestamp greater than `20260510000000_briefs_source_issue.sql`.

---

### Issue #6 — Repair: `major-claim-brief` RPC + Shell `purpose=repair` branch

**Why.** ADR 014 §"Schema changes" + §"Auto-retry decision (Shell side)". Plumbs the retry budget logic from the claim transaction through to Shell dispatch.

**Depends on Issue #5** (migration must be applied).

**expected_paths.**
- `supabase/migrations/<next-timestamp>_claim_brief_repair_purpose.sql` (RPC update — append-only migration that recreates the function)
- `shell/main.ts` (dispatch on `claim.run.purpose`)
- `shell/tachikoma.ts` (writes Repair input files when `role='repair'`)
- `shell/main-repair.test.ts` (new — unit tests for the dispatch logic if extractable)

**Acceptance criteria.**
1. `major-claim-brief` RPC (the SQL function called by the edge function of the same name):
   - On claim, queries the latest Run for the Brief (any outcome).
   - If no prior Run OR `brief.current_revision_id > latest_run.started_against_revision_id`: `attempt_number = 1`, `purpose = 'execute'`.
   - Else if `latest_run.outcome = 'failed'` AND `latest_run.attempt_number < brief.max_attempts`: `attempt_number = latest_run.attempt_number + 1`, `purpose = 'repair'`.
   - Else: `purpose = 'execute'`, `attempt_number = latest_run.attempt_number + 1` (covers manual re-arm cases).
2. `shell/main.ts:executeRun` dispatches on `claim.run.purpose`:
   - `'execute'` → existing flow (planner-gated → implementer → reviewer).
   - `'repair'` → new `runRepair(claim, ...)` function (defined in this Brief).
3. `runRepair`:
   - Fetches the prior Run's `verification_results` and `final_text` via service-role read on Major API (new helper, or direct PostgREST).
   - Writes `/work/.major/inspected_run.json`, `/work/.major/inspected_run_verifications.json`, `/work/.major/inspected_run_transcript_tail.txt` (last 4KB of `final_text`, secret-sanitized via existing `secretSanitizer`).
   - Invokes the Repair Tachikoma with `role='repair'`.
   - Treats the Repair output identically to Implementer for the rest of the flow (CI poll, Reviewer phase, finalize).
4. `shell/main.ts` finalization logic: if `outcome='failed'` AND `attempt_number < max_attempts`, set `nextStatus = 'ready-for-agent'` instead of `'ready-for-human'`. Above budget: keep `'ready-for-human'`.
5. `tsc --noEmit` clean. `npm test` passes.

**Scope boundaries.**
- Does NOT rewrite the Repair prompt (`shell/prompts/repair.md`). That's Issue #7.
- Does NOT add UI changes. That's Issue #8.
- Does NOT change Planner or Reviewer phases.

**Classifications.** `feature`. Multi-path → Planner gate fires.

**Notes for the Tachikoma.** This is the biggest Brief in the sequence. Slice the Planner output carefully — files-planned should match `expected_paths` exactly.

---

### Issue #7 — Repair: rewrite `shell/prompts/repair.md` from inspector to retry-implementer

**Why.** ADR 014 §"Repair Tachikoma inputs" re-scopes the existing stub to a retry-implementer that has prior-failure diagnostics. Same artifact contract as Implementer (produce a PR), just with extra context.

**Depends on Issue #6** (Repair input files must be written for the prompt to reference).

**expected_paths.**
- `shell/prompts/repair.md` (full rewrite)
- `shell/prompts/versions.ts` (bump `REPAIR_PROMPT_VERSION` to today's date per AGENTS.md rule #7)

**Acceptance criteria.**
1. `repair.md`:
   - Opens with the Instruction Trust Boundary (verbatim from existing prompt).
   - Frames Repair as the second-or-later attempt-implementer with access to prior-failure diagnostics, NOT as a read-only inspector.
   - Inputs section lists `/work/.major/brief.json`, `/work/.major/inspected_run.json`, `/work/.major/inspected_run_verifications.json`, `/work/.major/inspected_run_transcript_tail.txt`.
   - Process section instructs the Tachikoma to: (a) read all four files, (b) form a hypothesis about *why* the prior attempt failed, (c) attempt the Brief differently — explicitly avoid the failed approach.
   - Same final output JSON shape as the implementer prompt (`phase: "implementer"` since Repair produces the same artifact type; OR `phase: "repair"` if the parser at `main.ts:parseImplementerOutput` is updated to accept it — pick one consistent answer).
   - Hard rules section mirrors implementer's (no out-of-scope edits, no force-push, etc).
2. `REPAIR_PROMPT_VERSION` bumped to today's `<role>@YYYY-MM-DD`.
3. Same `## Linked` footer convention as implementer so PR Repository Correlation Receipts parse correctly.

**Scope boundaries.**
- Does NOT modify `shell/main.ts`, `shell/tachikoma.ts`, or any other prompt.
- Does NOT change the output parser. If the prompt outputs `phase: "repair"`, that's a Tachikoma-side change separate from this Brief.

**Classifications.** `refactor` (prompt rewrite, no new feature).

---

### Issue #8 — Repair: UI affordance (Re-arm-as-Repair + attempt badge)

**Why.** ADR 014 §"Human override" + UI follow-on. Operator surface for the retry-budget mechanism.

**expected_paths.**
- `ui/components/briefs/RearmButton.tsx` (extend existing; current source from PR #55)
- `ui/components/briefs/AttemptBadge.tsx` (new)
- `ui/app/(authenticated)/briefs/[briefId]/page.tsx` (renders the badge on Brief Detail)
- `ui/lib/api/briefs.ts` (new `rearmAsRepair` mutator)
- A new edge function: `supabase/functions/major-rearm-brief/index.ts` + `supabase/functions/major-rearm-brief/deno.json` + a small Deno test.

**Acceptance criteria.**
1. The existing Re-arm button (per PR #55) gains a second option "Re-arm as Repair" available when Brief is at `ready-for-human` AND the latest Run was `failed`. The two options are exposed as a dropdown or split-button per shadcn convention.
2. "Re-arm as Repair" calls the new `major-rearm-brief` edge function with `{ briefId, mode: "repair-override" }`. The function:
   - Sets `briefs.status = 'ready-for-agent'`.
   - Sets a coordination flag (or new column `briefs.next_claim_purpose = 'repair'`) so the next claim picks `purpose='repair'` regardless of budget.
   - Records an Event with `actor = 'human:<login>'`, `type = 'human-rearm'`, `payload.mode = 'repair-override'`.
   - Returns `{ ok: true }` or `{ ok: false, error }`.
3. `AttemptBadge.tsx` reads `latestRun.attempt_number` and `brief.max_attempts` and renders "attempt N of M". Hidden when no Runs exist or when attempt_number = 1.
4. Brief Detail page renders the badge next to the existing status badge.
5. SWR cache invalidation: after `rearmAsRepair` succeeds, the Brief Detail re-fetches.
6. `tsc --noEmit` clean for `ui/`. `deno check` clean for the new edge function.

**Scope boundaries.**
- Does NOT modify the existing Re-arm flow (the non-Repair re-arm stays).
- Does NOT change the auto-retry path. Only adds the human-override surface.
- Does NOT add new SQL tables. If `next_claim_purpose` needs a column, add it in a small migration sub-Brief.

**Classifications.** `feature`. Multi-path → Planner gate fires.

---

### Issue #9 — Docs: runbook + failure-modes updates

**Why.** Several places need small updates so the runbook reflects what shipped.

**expected_paths.**
- `docs/runbook.md`
- `docs/failure-modes.md`
- `CLAUDE.md`

**Acceptance criteria.**
1. `runbook.md` gains a "Inbound issue trigger" section explaining the `major:triage` label workflow (writes a brief operator guide).
2. `runbook.md` gains a "Retry budget" section explaining `briefs.max_attempts`, the auto-retry cap, and how the human-override Re-arm-as-Repair works.
3. `failure-modes.md` §18 gains a sub-case for the wontfix-close behavior (issue closes with `state_reason: "not_planned"`).
4. `failure-modes.md` adds a new entry for "Resolution comment failed but close succeeded" (and inverse) — the helper from Issue #3 surfaces these cases.
5. `CLAUDE.md` "Common mistakes to avoid" — the existing webhook-merger amendment from ADR 007 is generalized to "Major's terminal transitions (whether via webhook OR via UI confirm/reject) close the source issue with a resolution comment per ADR 011."

**Scope boundaries.**
- Docs-only. No code.

**Classifications.** `docs`.

---

## Summary

| Issue | Phase | LoC est | Path-blocker risk | Depends on |
|---|---|---|---|---|
| #1 ADR 010 implementation | 3a | ~300 + tests | none | (bootstrap — manual triage) |
| #2 Inbound verification | 3b/c | ~50 docs | none | #1 deployed |
| #3 `_shared/github-issue.ts` helper | 3d | ~250 + tests | none | none |
| #4 Wire helper into 3 callers | 3d | ~150 | none | #3 |
| #5 Schema migration | 2 | ~30 SQL | **migrations protected** → human-apply | none |
| #6 RPC + Shell branch | 2 | ~400 + tests | **migrations protected** → human-apply | #5 applied |
| #7 Repair prompt rewrite | 2 | ~200 | none | #6 |
| #8 UI affordance + edge function | 2 | ~300 + tests | none | #6 (`attempt_number` column) |
| #9 Docs sweep | — | ~100 docs | none | All above merged |

Total: ~1,500–1,800 LoC across ~9 Briefs.

### Done condition

The plan is complete when:
1. A GitHub issue opened on a watched repo with the `major:triage` label produces a Brief → Run → PR → merge → `done` flow with zero manual SQL or curl.
2. The resolution comment posts to the source issue on `done` and `wontfix`, and the issue closes in both cases.
3. A Brief whose first Run fails auto-retries below budget; above budget it parks at `ready-for-human` with the Re-arm-as-Repair button available.
4. Docs/runbook reflect all of the above.

Items 2 and 3 from PR #58's test plan (multi-path Planner gate fires, single-path gate skips) are passive observations — whichever issue first matches each gate-shape will check those boxes automatically.

---

## How a fresh session executes this

1. Read the docs in Step 0.
2. Run `/to-issues` against this file. Each entry above becomes one GitHub issue with body filled from the entry's Why + acceptance + scope sections.
3. Operator merges PR for Issue #1 manually (since inbound isn't live yet).
4. Operator applies the schema migration when Issue #5's PR is up for review (one-time).
5. Operator clicks Merge on remaining PRs as Major opens them.
6. Operator restarts Shells / deploys edge functions when prompted by the agent (or grants the agent permission to do it).
7. Total operator time: ~15 minutes spread across the plan.

Anything not anticipated above (a new failure mode surfacing, a Tachikoma stuck on a Brief) is handled per the existing runbook — `ready-for-human` for stuck Briefs, file follow-up issues for surprises.

When all 9 issues are `done`, the bottom-line plan-done condition flips. Intake works.
