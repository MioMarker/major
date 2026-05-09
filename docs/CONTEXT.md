# Major — Domain Glossary

When two terms refer to the same thing, this file is the tiebreaker. `SPEC.md` describes the system; this file fixes the vocabulary. If you find yourself reaching for a phrase that isn't defined here, check `SPEC.md` first; if still unsure, draft a glossary entry before shipping the code that uses it.

This file mirrors the grouping in `SPEC.md`'s "Primitives glossary" section. Each entry: name in **bold**, ≤ 3-sentence definition, then `_Avoid_:` listing phrases not to use.

---

## App boundary

**Major** — The orchestrator described by `SPEC.md`. The canonical name; never abbreviated, never qualified with "system" or "platform" in code or docs.
_Avoid_: "the orchestrator," "the system," "Major.io," "the agent runner" (Major contains a runner; it is not a runner).

**Major App** — The implementation rooted at `~/Projects/major`. Includes DB schema, edge functions, UI, and the Runner image.
_Avoid_: "the app" (ambiguous with HealthBite/Healix), "the codebase" (ambiguous with the dependent repos).

**Major UI** — The Next.js human surface deployed on Vercel. Renders Items, Triage Sessions, runs, artifacts, and Settings.
_Avoid_: "the dashboard," "the console," "the admin panel."

**Major APIs** — The edge function surface under `supabase/functions/major-*`. The only programmatic entry into the Workflow Store.
_Avoid_: "the backend," "the server," "Major core."

**Work Items View** — The default UI navigation area showing the filterable Item list, sorted by `queue_rank`. Other UI surfaces (Triage, Pending QA, Settings, Item Detail) are reached from here.
_Avoid_: "the queue UI," "the dashboard," "items list" (lowercase).

**System Specification** — `~/Projects/major/SPEC.md`. The authoritative source for primitives, lifecycle, schema, and API surface.
_Avoid_: "the spec doc," "design doc," "the architecture doc."

**Triage / AFK Agent Loop** — The end-to-end workflow Major implements: intake → Triage Session → Items → Run → review → acceptance.
_Avoid_: "the agent loop" (omits Triage), "the pipeline," "the flow."

**First Implementation Scope** — The two artifact types implemented in v1: `git-change` (primary) and `triage-change-set` (output of Auto Triage Run). Other artifact types are deferred.
_Avoid_: "MVP scope," "phase one features," "v1 artifacts" (use the explicit name).

---

## Authoritative state

**Workflow Store** — Major's authoritative state. The `major.*` schema in the dev Supabase project (`nuihvxluxdpdjgkvtdih.supabase.co`). Lifecycle decisions read this and only this.
_Avoid_: "the database," "Major DB," "Postgres" (those are implementation details), "the store" (ambiguous).

**Workflow Primitive** — Anything stored in the Workflow Store: Work Items, Events, Runs, Artifacts, etc. The set of primitives is defined by this glossary plus `SPEC.md`'s schema overview.
_Avoid_: "entity," "model," "record" (those are data-layer terms; Workflow Primitives are a domain concept).

**Work Item** — The durable unit of intent. One Work Item = one engineering task. Has Status, Classification, Content (versioned), Metadata, and possibly Relationships.
_Avoid_: "ticket," "issue" (GitHub Issues are not Items), "task," "story" (Agile baggage), "card."

**Work Item Status** — Lifecycle position. Exactly one of `{ready-for-triage, needs-info, ready-for-agent, agent-running, ready-for-review, ready-for-human, done, wontfix}`. Stored as a column; never derived.
_Avoid_: "state" (use "Status"; "state" colloquially overloads with the state machine), "stage," "phase" (those collide with Run phase terminology).

**Work Item Classification** — The "kind of work" tag. One of `bug-fix | feature | refactor | docs | parent | epic`. Orthogonal to Status.
_Avoid_: "type" (collides with `expected_artifact_type`), "category," "label" (label is a GitHub primitive).

**Work Item Relationship** — A typed edge between two Work Items. Edge types: `parent` (with Parent Review Requirement metadata) and `blocks` / `blocked-by`.
_Avoid_: "link," "reference," "dependency" (use `blocks`/`blocked-by`).

**Parent Review Requirement** — Metadata on a parent relationship indicating whether the parent must approve child finalization. Values: `required` (default), `optional`, `excluded`.
_Avoid_: "approval mode," "parent gating."

**Blocked Work Item** — Derived; an Item with at least one unresolved required relationship. Not a stored Status.
_Avoid_: "blocked status" (it isn't one), "stuck Item."

**Missing Information Request** — Content convention required for `needs-info` Status. Names what info is missing and what would unblock.
_Avoid_: "info request," "follow-up note," "blocker comment."

**Event** — Durable record of an attributed lifecycle action. Idempotent via Idempotency Key. Drives Status transitions; never used for non-lifecycle observation.
_Avoid_: "log entry," "audit event" (those are non-lifecycle; use Telemetry Record), "history record."

**Telemetry Record** — Durable operational observation that does not change Status. Performance, retries, side observations. Distinct table from Events.
_Avoid_: "log," "metric" (overloaded), "audit" (Events are the audit trail for lifecycle changes; Telemetry is everything else).

**Idempotency Key** — `(work_item_id, event_type, source_actor, source_delivery_id)`. Required on every retryable Event/Verification/Run-Finalization/Change-Operation write.
_Avoid_: "dedup key," "uniqueness key," "request id."

---

## Intent representation

**Work Item Content** — Human-readable PRD in Markdown. Versioned via Content Revisions. Lifecycle code never reads this — it's free-form.
_Avoid_: "description," "body," "PRD" (use "Content" or "Work Item Content"; "PRD" is fine in human-readable contexts but not the primitive name).

**Work Item Content Revision** — A specific durable version of Content. Runs execute against a specific `revision_id`. Editing Content creates a new revision; never mutate in place.
_Avoid_: "draft," "content edit," "version" (ambiguous with prompt versions and DB schema versions).

**Instruction Trust Boundary** — The principle that Work Item Content cannot override Major's policies (path-blocker, runner authority, verification rules, lifecycle transitions). Tachikoma prompts open by reaffirming this.
_Avoid_: "prompt safety," "agent guardrails," "content boundary."

**Ready-for-Agent Content** — Content convention required before Status enters `ready-for-agent`. Must include Acceptance Criteria, Scope Boundaries, and expected paths.
_Avoid_: "agent-ready content," "spec," "implementation brief."

**Ready-for-Agent Metadata** — Structured columns required before `ready-for-agent`: `expected_paths`, `expected_artifact_type`, `queue_rank`, `base_branch`, `git_repository_ref`.
_Avoid_: "agent metadata," "claim metadata."

**Acceptance Criteria** — Content section enumerating what must be true for a Run to be considered complete. Read by humans and Tachikomas; never parsed by the lifecycle.
_Avoid_: "definition of done," "DoD," "success criteria."

**Scope Boundaries** — Content section enumerating what is explicitly out of scope. Constrains Tachikoma behavior via the prompt; does not constrain the state machine.
_Avoid_: "out of scope notes," "non-goals."

---

## Triage

**Triage Session** — A durable, resumable conversation between a human and a Triage Tachikoma. The transcript is captured but is not authoritative — only the resulting Triage Change Set carries authority.
_Avoid_: "chat session," "intake," "intake form."

**Triage Session Transcript** — Message history of a Triage Session. Persisted for resumability and audit; never read by the state machine.
_Avoid_: "the transcript" (ambiguous), "chat log."

**Triage Change Set** — Structured proposal mapping a Triage Session's outcome to store mutations. Composed of Triage Change Operations. Applied atomically.
_Avoid_: "changeset" (one word), "diff," "patch," "Triage output."

**Triage Change Operation** — A single inspectable mutation within a Change Set. Types: `add-content-revision`, `set-classifications`, `add-relationship`, `set-parent-review-requirement`, `record-git-branch`, `set-ready-state`, `set-queue-rank`, `transition-work-item`, `create-item` (composite).
_Avoid_: "change op," "operation" (unqualified), "mutation."

**Auto Triage Run** — Agent-driven Run with `purpose=triage`. Emits a Triage Change Set as its Work Item Artifact. Subject to the path-blocker rule like any other Change Set.
_Avoid_: "triage agent run," "auto-triage," "triage automation."

**Auto Triage Request** — Scheduling primitive that asks Major to perform an Auto Triage Run on an Item. At most one non-terminal request per Work Item.
_Avoid_: "triage job," "triage queue entry."

**Auto Triage Request Status** — One of `requested | running | completed | failed | cancelled | superseded`.
_Avoid_: "triage state."

---

## Actor and authority

**Actor** — The principal accountable for a recorded action. One of `human | agent | runner | integration`.
_Avoid_: "user" (collides with auth.users), "principal," "owner."

**Agent** — Specifically Tachikoma (a Claude Code subprocess). Always runs under Runner accountability; an Agent never appears as the attributed Actor for state changes.
_Avoid_: "AI," "the bot," "the model" (Tachikoma is a process, not the model).

**Runner** — The workflow Actor accountable for Runs. Distinct from Runner Instance — `Runner` is the abstract role, `Runner Instance` is the container.
_Avoid_: "agent host," "execution context," "worker."

**Runner Instance** — A concrete long-lived Docker container with id, heartbeat, lease, and working directory. One container = one Runner Instance.
_Avoid_: "runner pod," "runner host," "container" (unqualified).

**Actor Authority Boundary** — The rule defining which Actor type may perform which transition. Humans own accept/reject/wontfix/done; runners own start/finalize/produce content/produce artifacts; agents act under runner accountability.
_Avoid_: "permissions," "RBAC," "authority matrix."

**Automated Acceptance Policy** — Opt-in primitive that, if set on an `artifact_type_contracts` row, allows that artifact type to enter `done` without a human accepting Actor. Primitive exists in v1; no policy is granted automation.
_Avoid_: "auto-accept," "auto-merge policy" (those collide with GitHub primitives).

---

## Run primitives

**Run** — A concrete attempt by an Actor on a Work Item. Has `purpose ∈ {execute, review, triage, repair}`, an `outcome`, coordination metadata, and produced artifacts.
_Avoid_: "job," "task execution," "build."

**Lifecycle-Path Run** — A Run whose completion is required for the normal route through the state machine. Equivalent to `purpose=execute`.
_Avoid_: "main run," "primary run," "happy-path run."

**AFK Review Run** — A Run with `purpose=review`. In v1, runs as Phase 2 of an execute Run inside the same sandbox; can also stand alone.
_Avoid_: "review job," "review pass" (use "Phase 2" when describing the implementer→reviewer sequence).

**Repair Run** — A Run with `purpose=repair`. Inspects stale or inconsistent state; never concurrent with the original Run; may terminalize the original only with explicit authority-transfer reason and inspected evidence.
_Avoid_: "recovery run," "fix-up run."

**Single Active Run Rule** — DB invariant: at most one Run per Work Item with `outcome='running'`. Enforced by partial unique index on `runs(work_item_id) where outcome='running'`.
_Avoid_: "exclusive run lock," "active run constraint."

**Run Start Transaction** — Atomic operation that claims an Item, creates a `running` Run, records a `run-started` Event, attaches coordination metadata, and transitions the Work Item Status. The only legitimate door from `ready-for-agent` to `agent-running`.
_Avoid_: "claim transaction," "run claim."

**Run Finalization Transaction** — Atomic operation that records a terminal Run outcome, emits `run-ended` Event, persists produced artifacts and Verification Results, snapshots final coordination metadata, and sets the next Work Item Status.
_Avoid_: "run completion," "finalize," "wrap-up" (use "Run Finalization Transaction" or "Run Finalization").

**Run Coordination Metadata** — `claim`, `lease_expires_at`, `heartbeat_at`, `runner_instance_id`, `sandbox_ref`, `log_artifact_refs`. Folded into the `runs` row; not a separate table.
_Avoid_: "run metadata" (ambiguous; reserved for non-coordination fields), "claim metadata," "lease info."

**Runner Scheduling** — The Runner Instance's selection of eligible Items. Sorted by `queue_rank` ascending; respects relationship eligibility; skips Items with active Auto Triage Runs.
_Avoid_: "scheduling," "scheduler" (those imply a server-side scheduler; Runners self-select).

**Runner-Eligible Work Item** — An Item where `status='ready-for-agent'`, not Blocked, artifact contract is supported, and the named repository is accessible.
_Avoid_: "claimable Item," "eligible Item" (use the full name to disambiguate from human-eligible).

---

## Cancellation and handoff

**Human Run Cancellation** — A cancellation requested by a human Actor. Always routes the Work Item to `ready-for-human`. Never auto-retries.
_Avoid_: "user cancel," "manual stop."

**System Run Cancellation** — A cancellation initiated by Major itself (e.g., lease expiry, sandbox crash). Routes to `ready-for-agent` if a clean retry is safe; otherwise `ready-for-human`.
_Avoid_: "auto-cancel," "automatic cancellation," "system stop."

**Human Handoff** — The Event recorded when an Item enters `ready-for-human`. Names the reason and the action expected from the human.
_Avoid_: "escalation," "manual handoff," "human review request."

---

## Artifact

**Primary Expected Artifact Type** — The single `expected_artifact_type` set on an Item before `ready-for-agent`. One Item = one expected artifact.
_Avoid_: "artifact type," "primary artifact."

**Artifact Type Contract** — Static definition (one row in `major.artifact_type_contracts`) of claim/produce/review/verify/accept rules per artifact type. v1 contracts: `git-change`, `triage-change-set`.
_Avoid_: "artifact rules," "contract" (unqualified).

**Work Item Artifact** — A durable output produced by a Run: Git Change, Pull Request, or Triage Change Set. Stored in `major.work_item_artifacts`.
_Avoid_: "deliverable," "output," "artifact" (unqualified — disambiguate from build artifacts).

**No-Change Completion** — Terminal completion of a Run that produces no artifact. Allowed only when Ready-for-Agent Content explicitly permits it (e.g., "investigate-only" Items).
_Avoid_: "empty run," "no-op completion."

---

## Verification

**Verification Result** — Durable record of a check (test, lint, typecheck, eval gate) attached to a Run. Required vs advisory is determined by Verification Result Metadata.
_Avoid_: "test result" (verification includes lint/gate/typecheck), "check result," "CI result."

**Verification Result Metadata** — Structured fields including `required: bool` and Verification Requiredness Source. Determines whether the result blocks Run Finalization.
_Avoid_: "check metadata."

**Verification Requiredness Source** — One of `artifact-type-policy | ready-for-agent-content | human-override | automated-acceptance-policy`. Names where the requiredness came from.
_Avoid_: "required-by," "requiredness reason."

---

## Repository integration

**Git-Native Workflow** — A workflow that treats Git as a first-class concept (branches, commits, PRs are Workflow Primitives). Major's primary workflow is Git-Native; Auto Triage Runs are not.
_Avoid_: "Git workflow" (ambiguous), "Git-based workflow."

**Git Repository Reference** — Durable reference to a Git repo (e.g., `MioMarker/healthbite`). Each Item names exactly one. Stored on `work_items`.
_Avoid_: "repo," "repository" (unqualified — could be the dev Supabase reference too).

**Git Branch** — A named ref. Major creates exactly one per Item: `major/work-item-<id>`, off `dev`.
_Avoid_: "branch" (unqualified — disambiguate from main/dev).

**Git Commit Reference** — A `(base_sha, head_sha, compare_range)` tuple identifying a specific change set on a branch. Stored on a Run's coordination metadata.
_Avoid_: "commit," "SHA" (those are sub-fields).

**Git Change** — The artifact type representing a commit set or diff produced for a Work Item. The primary `expected_artifact_type` in v1.
_Avoid_: "code change," "patch," "diff" (those are content; Git Change is the artifact primitive).

**Pull Request** — Review/integration request for a Git Change. A Workflow Primitive; mirrors a GitHub PR but is authoritative in Major's store.
_Avoid_: "PR" (acceptable in casual prose; use "Pull Request" in code and docs that define behavior), "merge request."

**Pull Request Status** — `absent | open | merged | closed`. Distinct from Work Item Status; updated via webhook.
_Avoid_: "PR state," "merge status."

**Pull Request Derived Fact** — Read-only facts mirrored from GitHub: approvals, requested changes, CI status, branch protection state, conflicts. Treated as Telemetry; never authoritative for lifecycle decisions.
_Avoid_: "PR data," "GitHub state."

**Pull Request Association Metadata** — Structured receipt embedded in a PR body that links it back to a Work Item.
_Avoid_: "PR linkage," "PR association."

**Repository Correlation Receipt** — Provider-side metadata linking a PR to a Work Item. In Major: the line `Major-item: <id>` in the PR body.
_Avoid_: "PR backlink," "PR id," "correlation tag."

---

## Queue and routing

**Queue Metadata** — Per-Item routing fields: `queue_rank` (int, sortable, lower runs first), optional `priority_class`, and `placement_reason` (free text from triage).
_Avoid_: "priority," "rank" (unqualified).

**Path-Blocker Rule** — Major-specific deterministic check on every Triage Change Set apply. Compares `expected_paths` against an editable list of protected globs and applies a mass-rerank threshold.
_Avoid_: "path filter," "protected paths check," "the blocker."

---

## Telemetry, repair

**Repair Inspection Trigger** — A signal asking Major to inspect potentially inconsistent state (heartbeat lapse, finalization failure, divergent branch). The trigger does not decide an outcome — only a Repair Run does.
_Avoid_: "repair signal," "reaper trigger."

**Lease-Expiry Reaper** — A `pg_cron` job that detects expired claims, marks them, and may emit a Repair Inspection Trigger. Distinct from a Repair Run.
_Avoid_: "the reaper" (acceptable casually), "lease cron," "lease watchdog."
