# 010. Inbound GitHub issue → Triage Session (opt-in via `major:triage` label)

## Status

`Proposed`

Date: 2026-05-10

## Context

Major's lifecycle entry today is manual: a human opens the UI, starts a Triage Session via chat, grills the Triage Tachikoma into producing a Change Set, and applies it. The intake-and-stubs plan (`docs/plans/intake-and-stubs/00-briefing.md`) Phase 3a wires the *other* entry point: a GitHub issue arriving on a watched repo flows through the same Triage Session machinery automatically.

The downstream machinery already exists. `major-create-triage-session`, `major-start-auto-triage`, `major-finalize-triage-session`, `major-apply-change-set`, the path-blocker, and the Triage Tachikoma prompt (`shell/prompts/triage.md`) all ship. What's missing is the *trigger*: nothing today watches issue events and POSTs to `major-create-triage-session` with the issue body as the seed.

This ADR fixes that. It is decision-class because it answers four questions whose wrong choices would shape the inbound flow in directions hard to back out of: what gates the trigger, which repos are watched, who counts as a valid issue author, and who is recorded as the Brief Content author when Triage produces a Brief.

### What "inbound" means here

A GitHub `issues` webhook event arrives at `major-github-webhook`. The handler decides whether to seed a Triage Session. If yes, it POSTs to `major-create-triage-session` with:
- the issue body as the initial Content seed,
- `source_issue_repo` and `source_issue_number` populated on the eventual Brief (per ADR 007's schema),
- the issue's author login captured for audit but NOT used as the Brief Content author.

The Triage Tachikoma then runs (Auto Triage Run, `purpose=triage`), produces a Change Set, and the path-blocker (ADR 002) decides whether the Change Set auto-applies or queues for human apply. Existing wiring; no new lifecycle states.

### Alternatives considered

#### Trigger gate

1. **Opt-in via `major:triage` label (chosen).** Issues only trigger Triage when explicitly tagged with the label. Default OFF. The label is added either at issue creation (issue template can pre-set it) or later via `issues.labeled` events. Lowest blast radius for v1 dogfood — only issues the operator explicitly marks get Tachikoma turns spent on them, and noisy issues (low-effort, comment-thread debates) stay quiet by default. Aligns with the briefing's "Default recommendation: opt-in via label for v1; broaden after dogfooding."

2. **Every newly opened issue triggers.** Maximum coverage. Rejected — noise risk is real. A typical week's issue volume on the dependent repos includes question threads, duplicate reports, and clarification requests that aren't real work-orders. Spending a Triage Tachikoma Run on each is wasteful and dilutes the signal of "this Brief is on the queue."

3. **Opt-in via label + opt-out via `major:skip` label.** Default ON for opened issues, suppress via opt-out. Rejected — same noise risk as (2) plus operator burden of remembering to opt-out on every non-work issue. The default-OFF posture is strictly cheaper.

#### Repo allowlist

1. **All three (`major`, `healthbite`, `healix`) watched (chosen).** Webhooks are already registered per `docs/runbook.md` §1.6. Aligns with the existing PR webhook surface — symmetric. Operators are used to thinking of all three repos as "Major-driven."

2. **Just `MioMarker/major` (self-host dogfood first).** Smaller risk surface, but the briefing's Phase 3 already presumes the symmetry; deferring `healthbite`/`healix` is a phase-creation step rather than a real cut. The webhook handler is the same; the only difference is whether the label is checked. Rejected as artificial restriction.

3. **`major` + `healthbite` only (defer `healix`).** Rejected for the same reason — the gate logic is uniform; the cut would be cosmetic.

#### Issue author

1. **Human-only in v1 (chosen).** Only issues opened by non-bot GitHub accounts trigger Triage. The handler checks `issues.opened.sender.type === "User"` (GitHub's `sender.type` is `"User"` for humans, `"Bot"` for apps and bot accounts). Trust-boundary clean: a Tachikoma running with a fine-grained PAT cannot surface follow-up work by opening an issue and looping itself into the queue.

2. **Both human and agent authored.** Allows agent-driven self-improving Briefs (Tachikoma surfaces a follow-up via issue → Triage → Brief). Rejected for v1 — opens an agent-authored loop without a corresponding kill-switch, and the human-authored path covers every actual operator workflow today. If a self-improving flow becomes desirable, a separate ADR can add a narrowly-scoped "agent may open follow-up issues from a fixed list of triggers" path.

#### Brief Content author

1. **`agent:triage-tachikoma:<run_id>` (chosen).** The Triage Tachikoma wrote the Brief Content (it produced the structured PRD from the unstructured issue body), so attribution goes to the agent that actually wrote those words. The human's role in the chain is preserved separately: the source issue's coordinates live on `briefs.source_issue_repo` + `source_issue_number` (per ADR 007), and Events for the Triage Session retain the human as the trigger.

2. **`human:<issue_author_login>`.** Records the issue author as the Brief Content author. Rejected — misattributes who actually wrote the PRD text. The human wrote the issue body (a few sentences of intent); the Tachikoma wrote the Brief Content (acceptance criteria, scope boundaries, expected paths, classifications). Mixing the two confuses Content authorship — used downstream by reviewer logic and by event-log attribution.

### Forces

- **Trust boundary is non-negotiable.** AGENTS.md hard rule #1 (Cyberbrain is authoritative) and the Instruction Trust Boundary (`SPEC.md` §Tachikoma roles) constrain how the inbound seed is handled. Issue body is Content — opaque to lifecycle code, parsed only by the Triage Tachikoma under the Trust Boundary. The handler does NOT parse issue body for state hints; it just forwards.
- **Idempotency.** The `issues.opened` and `issues.labeled` webhook deliveries can be re-fired (GitHub's redelivery semantics). The handler must use the existing idempotency-key pattern (`major.events.idempotency_key`) so a redelivery doesn't double-create a Triage Session.
- **Path-blocker is downstream.** The label-gated trigger fires Triage; the path-blocker still gates which Change Sets auto-apply. No double-gating; each axis has its own purpose.
- **ADR 007's `source_issue_*` columns exist.** This ADR uses them as-is. No new schema for inbound correlation.
- **Webhook auth is HMAC-SHA256 (`verify_jwt = false`).** Already configured. No changes.
- **`issues.labeled` is the symmetric trigger to `issues.opened`.** An operator who opens an issue without the label and adds it later expects Triage to fire when the label lands. Both events must trigger.

## Decision

### Trigger logic

The `major-github-webhook` handler is extended to handle `X-GitHub-Event: issues` payloads:

```ts
if (event === "issues") {
  await handleIssue(client, payload, delivery);
}
```

`handleIssue` fires a Triage Session iff ALL of the following hold:

1. `payload.action === "opened"` AND the issue's labels include `major:triage`, OR
2. `payload.action === "labeled"` AND the just-added label is `major:triage` AND the issue is not in a terminal state (`payload.issue.state === "open"`).

Plus the universal gates:
- The issue's `sender.type === "User"` (no bots).
- The repo is in the watched allowlist: `MioMarker/major`, `MioMarker/healthbite`, `MioMarker/healix`.
- No Triage Session already exists for this issue (idempotency — see below).

Other actions (`closed`, `reopened`, `edited`, `unlabeled`, `assigned`, etc.) are explicitly ignored. Particularly:
- `unlabeled` (removing `major:triage`) does NOT retract an in-flight Triage Session. Once seeded, the Session is durable; unlabeling is a "no longer want this triaged" signal we ignore in v1 (operators can reject the resulting Brief if they change their mind).
- `edited` (issue body changed) does NOT update the in-flight Session. The Session captured the body at trigger time. If the body genuinely changes, the operator can manually create a new Content Revision via Triage Session UI.

### Seed payload

The handler POSTs to `major-create-triage-session` with:

```json
{
  "entry_point": "integration:github",
  "trigger_payload": {
    "source_issue_repo": "MioMarker/healthbite",
    "source_issue_number": 123,
    "source_issue_url": "https://github.com/MioMarker/healthbite/issues/123",
    "source_issue_author_login": "<github-login>",
    "source_issue_title": "<title>",
    "source_issue_body_md": "<full body as posted>",
    "source_issue_created_at": "<iso>",
    "github_delivery": "<delivery id from webhook header>"
  }
}
```

`major-create-triage-session` (existing function) is amended to:
1. Accept `trigger_payload.source_issue_*` fields.
2. Persist them on the Triage Session row.
3. Pass them through to the Triage Tachikoma so its prompt can read them.
4. When the Triage Change Set's `create-brief` operations apply, the resulting `briefs.source_issue_repo` + `source_issue_number` are populated from the Triage Session's trigger payload (per ADR 007's `briefs.source_issue_*` columns).

### Brief Content authorship

Every `create-brief` Change Operation produced by an Auto Triage Run records the initial Content Revision's `author_actor` as:

```
agent:triage-tachikoma:<run_id>
```

Where `<run_id>` is the Triage Run that emitted the Change Set. This is set inside `major-apply-change-set` when the operation is applied. The human who opened the issue is NOT recorded as the Brief Content author — they're recorded as `source_issue_author_login` on the Triage Session and visible via the `source_issue_*` columns on the resulting Brief.

### Idempotency

A Triage Session originating from a GitHub issue is uniquely identified by `(source_issue_repo, source_issue_number)`. The handler checks `triage_sessions` for an existing row with those coordinates before creating a new one:

```sql
select id from major.triage_sessions
where trigger_payload->>'source_issue_repo' = $1
  and (trigger_payload->>'source_issue_number')::int = $2
  and outcome is null  -- not finalized; finalized sessions don't block re-trigger
limit 1;
```

If a non-finalized Session exists, the handler logs and skips. If only finalized Sessions exist (e.g. the operator finalized the prior one, then the issue got re-labeled), the handler creates a fresh Session — the prior Session's Briefs aren't retroactively reopened.

Event idempotency reuses the existing key shape: `deriveIdempotencyKey(null, "triage-session-created", "integration:github", delivery)`. Same delivery → same key → duplicate insert is a no-op.

### Issue template suggestion (operational, not normative)

The Major repo's issue templates can pre-set the `major:triage` label so operators don't have to remember. This is a follow-on UX nicety, not part of the ADR. The label is the authority; how it gets onto the issue is operator choice.

### What this ADR explicitly does not do

- **Does not parse the issue body for state directives.** Brief Content (and issue body that becomes the Brief Content seed) carries intent, not authority — AGENTS.md hard rule #2. The Triage Tachikoma reads the issue body under the Trust Boundary and decides what Brief shape to propose; no part of `handleIssue` parses for "Major-priority: high" or similar.
- **Does not handle agent-authored issues.** A Tachikoma running with a PAT and opening an issue is filtered out by the `sender.type === "User"` check. A future ADR can carve out specific agent-authored issue sources if a real need surfaces.
- **Does not handle issue edits.** Once a Triage Session is seeded, its trigger payload is durable. If the operator edits the issue, the Session doesn't update. Out of scope; operators can run a fresh Triage Session manually if needed.
- **Does not handle issue closure.** Closing the source issue while a Triage Session is in-flight is a no-op on the inbound side. The outbound sync (ADR 011) handles the symmetric case (Brief closes → issue closes).
- **Does not introduce a new Brief Status or new Event types.** The existing `triage-session-created` and `triage-session-finalized` Events absorb the inbound flow. `pr-opened` / `pr-closed` etc. stay PR-shaped.
- **Does not change the path-blocker.** Path-blocker runs at Change Set apply time, unchanged. An inbound-triggered Change Set is subject to the same auto-apply / human-apply decision as any other.

### Numbering note

Reserved per the briefing for inbound. ADRs 012, 013, 014 already exist; this ADR was deliberately numbered `010` to honor the briefing's "ADR 010 = inbound, ADR 011 = outbound" mapping rather than continuing monotonic from `014`. ADR README's "monotonically increasing" wording allows gaps; this fills one.

## Consequences

### Positive

- **Closes the manual-entry gap.** The most common inbound flow (operator files an issue) becomes one click (add the label) → automatic Triage Session. No more "now open the UI and copy the issue body into a chat."
- **Trust boundary preserved.** Issue body is treated as Content; lifecycle code never parses it. The Trust Boundary remains the only soft check on adversarial PRDs.
- **Reuses every downstream piece.** `major-create-triage-session`, `major-finalize-triage-session`, `major-apply-change-set`, path-blocker, Triage Tachikoma — all unchanged. The PR for this work is small: just the webhook handler extension + the `trigger_payload` plumbing on `major-create-triage-session`.
- **Symmetric with ADR 007's outbound `source_issue_*` columns.** Inbound populates the same columns that outbound auto-close uses. The pair forms a clean correlation loop.
- **Idempotent on redelivery.** Existing Event idempotency-key pattern covers the inbound surface; no new mechanism.
- **Default-OFF is reversible.** If `major:triage` opt-in proves too high-friction, opening the gate (every issue triggers) is a one-line change. The opposite direction (gate down after wide-open noise) is more painful.

### Negative

- **Operators must remember the label.** Friction cost on every inbound issue. Issue templates can mitigate but don't eliminate. Some real work-issues will get missed until labeled.
- **Issue edits don't propagate.** If an operator opens an issue, labels it, then edits the body to clarify scope, the in-flight Triage Session has stale input. They can manually trigger a new Session, but the workflow is awkward.
- **Sender-type filtering is GitHub-payload-dependent.** If GitHub adds new `sender.type` values (some kind of OAuth-app-installation?), the filter may need updating. Low risk; well-documented payload shape.
- **No retraction path.** Unlabeling doesn't cancel the in-flight Session. An operator who opens-and-immediately-regrets-labeling has to wait until the Session produces Briefs they can reject.
- **`source_issue_author_login` is captured on the Session but not on the Brief.** Operators querying "who reported this Brief?" go through `briefs.source_issue_*` → GitHub API → issue author. Acceptable; the audit trail is intact.

### Follow-on work

- **Implementation PR** (separate, per Phase 3a slicing): extend `major-github-webhook`'s `handleIssue`, amend `major-create-triage-session` to accept the `trigger_payload`, set the agent attribution in `major-apply-change-set` on `create-brief` ops, idempotency-key check on `triage_sessions`.
- **Issue template**: `.github/ISSUE_TEMPLATE/triage.md` on each watched repo, pre-setting the `major:triage` label. Operational; not part of the implementation PR.
- **Webhook event registration**: confirm `Issues` is in the event list for the webhook on all three repos per `docs/runbook.md` §1.6. Add it if missing.
- **Triage prompt amendment**: `shell/prompts/triage.md` already knows about `briefs.source_issue_*` (per the source_issue model). When the trigger payload arrives via `integration:github`, the prompt should also be aware of `source_issue_body_md` so it can include the issue body as the Brief Content seed without re-deriving it. Bump `TRIAGE_PROMPT_VERSION` per AGENTS.md hard rule #7.
- **UI**: `/triage/[sessionId]` should render the source issue link prominently when present. Operators reading the Triage page want a one-click jump to the originating issue.
- **Operator runbook addition**: `docs/runbook.md` gains a section on the inbound flow — how to opt an issue in, how to monitor the resulting Session, how to handle a Session that produces Briefs the operator no longer wants.

### Revisit conditions

- **Operators routinely miss adding the label.** Friction is too high; consider every-issue-triggers + opt-out, or auto-label via heuristic (issue assigned to a Major maintainer, etc.).
- **Issue edits create stale Sessions in practice.** Add an `issues.edited` handler that creates a new Content Revision on the existing Session (or supersedes it).
- **Self-improving Briefs become a real workflow.** Open a narrowly-scoped agent-author exception ADR.
- **Triage Tachikoma's structured PRD differs meaningfully from the issue body** to the point where the Session UI feels like it's hiding the original. Add a UI affordance to show issue-body + PRD side-by-side.
- **A Brief produced by inbound Triage proves controversial** (path-blocker false positive on the auto-apply path, or false negative). Postmortem informs path-blocker globs.

## References

- `docs/plans/intake-and-stubs/00-briefing.md` Phase 3a — the plan slot this ADR fills.
- ADR 007 — Auto-close Brief and source GitHub issue on PR terminal events; provides the `briefs.source_issue_*` columns this ADR populates inbound.
- ADR 002 — Path-Blocker Rule; runs downstream of the inbound trigger, unchanged.
- `supabase/functions/major-github-webhook/index.ts` — receives the `handleIssue` extension.
- `supabase/functions/major-create-triage-session/` — receives the `trigger_payload` plumbing.
- `supabase/functions/major-apply-change-set/` — sets `agent:triage-tachikoma:<run_id>` on `create-brief` ops.
- `shell/prompts/triage.md` — Triage Tachikoma prompt; receives a small amendment in the implementation PR.
- AGENTS.md hard rule #1 (Cyberbrain is authoritative), #2 (Content vs Metadata), #5 (Path-blocker is non-optional), #6 (Idempotency keys).
- `docs/runbook.md` §1.6 — webhook registration on the three watched repos.
