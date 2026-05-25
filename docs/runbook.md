# Major — Operational Runbook

How to set Major up, run it day-to-day, and handle the situations that come up. Companion to `SPEC.md` (architecture) and `docs/failure-modes.md` (catalog of what can go wrong).

This runbook assumes the dev Supabase project (`nuihvxluxdpdjgkvtdih.supabase.co`) is the target. There is no production Major project in v1 — Major itself is dev-only; the systems it drives (HealthBite, Healix) have their own production environments.

Vocabulary follows ADR 004 (Brief / Shell / Cyberbrain). The Cyberbrain is realised as the `major.*` schema (the schema name is unchanged).

---

## 1. Initial setup

One-time. Skip sections you've already done.

### 1.1 Link to the dev Supabase project

```bash
cd ~/Projects/major
npx -y supabase link --project-ref nuihvxluxdpdjgkvtdih
```

Verify with `npx -y supabase projects list` — the linked project shows a `●` bullet.

### 1.2 Apply the schema

```bash
npx -y supabase db push --dry-run                           # confirm what will apply
SUPABASE_DB_PASSWORD='<dev-postgres-admin-password>' \
  npx -y supabase db push
```

This creates the `major.*` schema, all tables in `supabase/migrations/20260509000000_initial_schema.sql`, applies `supabase/migrations/20260509000001_rpc_functions.sql` (the Postgres RPCs), and inserts the seed `path_blocker_config` row plus the `artifact_type_contracts` rows for `git-change` and `triage-change-set`.

The password is the dev project's Postgres admin password (Jonathan has it in 1Password). Never inline it in scripts or docs.

### 1.3 Set edge function secrets

```bash
# OpenAI key for Triage Sessions and Tachikoma calls
npx -y supabase secrets set OPENAI_API_KEY=<key>

# GitHub token for webhook signature verification
npx -y supabase secrets set GITHUB_WEBHOOK_SECRET=<secret>

# Used by major-github-webhook for outbound gh calls when needed
npx -y supabase secrets set GITHUB_APP_TOKEN=<token>
```

### 1.4 Deploy edge functions

```bash
for fn in \
  major-apply-change-set \
  major-auto-triage-sessions \
  major-claim-brief \
  major-confirm-qa \
  major-create-github-issue \
  major-create-triage-session \
  major-delete-brief \
  major-delete-triage-session \
  major-finalize-run \
  major-finalize-triage-session \
  major-get-brief \
  major-get-settings \
  major-get-triage-session \
  major-github-webhook \
  major-heartbeat \
  major-import-external-issues \
  major-list-briefs \
  major-list-external-issues \
  major-list-triage-sessions \
  major-merge-pr \
  major-quick-start \
  major-reaper \
  major-rearm-brief \
  major-record-telemetry \
  major-reject-brief \
  major-send-triage-message \
  major-start-auto-triage \
  major-update-settings; do
  npx -y supabase functions deploy "$fn"
done
```

Order doesn't matter; each function is independent. The reaper is invoked by `pg_cron`; the deploy command publishes the function — schedule registration is in the migration.

### 1.5 Build and push the Shell image

```bash
cd ~/Projects/major/shell
docker build -t major-shell:latest .

# Tag + push if/when we adopt a registry; v1 runs locally
```

The Shell image must include: `deno`, `node20`, `gh`, `git`, and the Claude Code CLI. It is rebuilt on every Shell code change; it is never patched in place.

### 1.6 Register GitHub webhooks on driven repos

For each repo Major drives — `MioMarker/healthbite`, `MioMarker/healix`, **and `MioMarker/major` itself** — register a webhook:

1. Settings → Webhooks → Add webhook.
2. Payload URL: `https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1/major-github-webhook`
3. Content type: `application/json`.
4. Secret: same value as `GITHUB_WEBHOOK_SECRET` from step 1.3.
5. Events: `Pull requests`, `Check runs`, `Pushes`, `Issues`. (`Issues` events trigger Triage Session creation per ADR 010 when an issue is labeled `needs-triage`.)
6. Active: yes.

`MioMarker/major` is on the list because Major drives PRs against itself for self-improving Briefs (doc edits, ADR follow-ups, internal tooling). Without the webhook registered there, the ADR 007 auto-close handler never sees the merge and the Brief stays stuck at `ready-for-review`. (This was caught during the first end-to-end dogfood of the auto-close webhook — see Brief 12 / PR #39, 2026-05-10.)

After adding, push a no-op commit on the repo and confirm a `push` event lands in the webhook delivery log + a Telemetry Record appears in `major.telemetry_records`.

### 1.7 Boot a Shell

```bash
docker run --rm \
  --name shell-A \
  -e SHELL_ID=shell-A \
  -e MAJOR_API_BASE_URL=https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1 \
  -e SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  -e GITHUB_TOKEN=<fine-grained-PAT — see token scope below> \
  -e CLAUDE_CODE_OAUTH_TOKEN=<from `claude setup-token` — Max subscription> \
  major-shell:latest
# Alternative if no Max plan: replace CLAUDE_CODE_OAUTH_TOKEN with
#   -e ANTHROPIC_API_KEY=<sk-ant-...>
```

The Shell authenticates to Major's API via `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` plus a `X-Major-Shell-Id` header. The auth helper (`supabase/functions/_shared/auth.ts`) recognizes the service-role bypass and attributes calls to `shell:<SHELL_ID>`. No user JWT is involved; Shells are not `auth.users` rows.

The Shell registers itself in `major.shells` on boot, then enters the main loop.

### 1.7.1 GitHub PAT scope (`major-shell-bot`)

Per `docs/adr/015-major-shell-bot-identity.md`, the Shell's `GITHUB_TOKEN` and the GitHub token used by `major-github-webhook` for outbound calls (`GITHUB_APP_TOKEN`) are both fine-grained PATs belonging to the **`major-shell-bot`** GitHub user account — not to any human dev. The bot has Write-role collaborator access on each driven repo and is intentionally absent from `.github/CODEOWNERS`.

The PAT must grant the following on each of `MioMarker/major`, `MioMarker/healthbite`, and `MioMarker/healix`:

| Permission | Used by | Why |
|---|---|---|
| `Contents: Write` | Shell | Push branches, create commits |
| `Pull requests: Write` | Shell | Open / update PRs, post review comments |
| `Issues: Write` | Shell + `major-github-webhook` (ADR 007 / 011) | Close source GitHub issue + post linking comment when the PR-merge webhook fires for a Brief with `briefs.source_issue_*` populated |
| `Actions: Read` | Shell | Read CI status (Mode 1 pre-flight per ADR 017) |

**Expiration: max 1 year** (GitHub's ceiling for fine-grained PATs). Store the PAT in 1Password under `major-shell-bot github PAT`. Rotation is part of the operator's monthly checklist (§ 2.5). After rotation, update the Shell `.env` AND `npx -y supabase secrets set GITHUB_TOKEN=<new-token>` so the webhook handler also picks up the new value, then restart any running Shells so they pick up the new env var.

---

## 2. Day-to-day operations

### 2.1 Monitoring runs via the UI

The Briefs View (default at `/`) lists all Briefs by Status. Filter on `agent-running` to see active Runs; filter on `ready-for-review` for Briefs awaiting human QA; filter on `ready-for-human` for stuck Briefs needing intervention.

Brief Detail (`/briefs/<id>`) shows: current Content revision, full Events log, every Run with its outcome and Verification Results, all produced Artifacts (with PR links), and the relationship graph.

For at-a-glance Shell health: Settings → Shell Pool. Shows each `shells` row with last heartbeat. Stale heartbeats (> 90s) are flagged; > 5 min triggers Lease-Expiry Reaper alerts.

### 2.2 Manual lease repair

Sometimes a Shell crashes in a way the reaper hasn't caught yet, leaving a Brief in `agent-running` with a dead lease. Manual repair:

```sql
-- Identify the stuck Run
SELECT id, brief_id, shell_id, lease_expires_at
FROM major.runs
WHERE outcome = 'running' AND lease_expires_at < now() - interval '5 minutes';

-- Cancel the Run (System Run Cancellation, clean retry path)
UPDATE major.runs
SET outcome = 'cancelled',
    cancellation_reason = 'manual-repair',
    ended_at = now()
WHERE id = '<run-id>';

-- Reset the Brief to ready-for-agent (clean retry)
UPDATE major.briefs
SET status = 'ready-for-agent'
WHERE id = '<brief-id>';

-- Record the manual intervention as Events for audit
INSERT INTO major.events
  (brief_id, run_id, type, actor, idempotency_key, payload)
VALUES
  ('<brief-id>', '<run-id>', 'run-ended', 'human:<your-user-id>',
   'manual-repair-run-ended-' || gen_random_uuid(),
   jsonb_build_object('cancellation_reason', 'manual-repair'));

INSERT INTO major.events
  (brief_id, run_id, type, actor, idempotency_key, payload)
VALUES
  ('<brief-id>', '<run-id>', 'status-transitioned', 'human:<your-user-id>',
   'manual-repair-status-' || gen_random_uuid(),
   jsonb_build_object('from', 'agent-running', 'to', 'ready-for-agent', 'reason', 'manual-repair'));
```

Run all five statements in a single transaction (`BEGIN;` … `COMMIT;`). Without the Events, the audit trail is broken; without the status update, the Reaper will keep firing.

If the situation looks unsafe to retry (e.g., the Shell committed bad code that's now in `dev`), set the Brief to `ready-for-human` instead of `ready-for-agent`.

### 2.3 Re-running a failed Brief

A Brief that failed and was routed to `ready-for-human` (Run Finalization with Human Handoff) is intentionally stuck. To resubmit it:

1. Open Brief Detail. Read the most recent Run's Events and Verification Results to understand what went wrong.
2. If the issue is content (PRD missing detail, expected_paths wrong): edit Content → new Brief Content Revision → Triage Change Set → re-apply path-blocker → Status returns to `ready-for-agent`.
3. If the issue is environmental (transient sandbox error, GitHub flake): no Content change needed. Run this:

```sql
UPDATE major.briefs SET status = 'ready-for-agent' WHERE id = '<id>';

INSERT INTO major.events
  (brief_id, type, actor, idempotency_key, payload)
VALUES
  ('<id>', 'human-resubmit', 'human:<your-user-id>',
   'resubmit-' || gen_random_uuid(),
   jsonb_build_object('reason', 'transient-failure', 'previous_run_id', '<run-id>'));
```

Never reset a Brief to `ready-for-agent` without recording an Event — the audit trail and the lifecycle invariants depend on it.

### 2.4 Inspecting the Events log

```sql
-- Most recent 50 events across all Briefs
SELECT created_at, brief_id, type, actor, payload
FROM major.events
ORDER BY created_at DESC
LIMIT 50;

-- Events for a single Brief
SELECT created_at, type, actor, payload
FROM major.events
WHERE brief_id = '<id>'
ORDER BY created_at ASC;

-- Find a stalled Run by event type
SELECT *
FROM major.events
WHERE type = 'run-started'
  AND brief_id NOT IN (
    SELECT brief_id FROM major.events WHERE type = 'run-ended'
  );
```

Telemetry Records live in `major.telemetry_records` and are queried similarly. Events drive lifecycle; Telemetry is observation only.

### 2.5 Inbound issue trigger

When a human (or automation) applies the `needs-triage` label to a GitHub issue in a driven repo, the `major-github-webhook` function intercepts the `issues.labeled` event, creates a Triage Session against that issue's content, runs auto-triage, and produces a Draft Brief. If the Draft Brief is accepted, it is queued at `ready-for-agent`.

**Operator guide.**

1. Apply the `needs-triage` label to the issue in GitHub. The label must match the configured name exactly (`needs-triage`); any casing mismatch silently drops the event.
2. Within a few seconds, expect: a comment posted on the issue confirming intake, and the label transitioning from `needs-triage` to `needs-triaged` (or `needs-triage-failed` on error).
3. A new Brief appears in the Briefs View at `draft` or `ready-for-agent` depending on the auto-triage outcome.

**Nothing happened — troubleshooting.**

- Check the webhook delivery log: GitHub repo → Settings → Webhooks → Recent Deliveries. Confirm an `issues` event with `action=labeled` was delivered and returned `2xx`.
- Confirm the label name in the delivery payload matches `needs-triage` exactly.
- Check Supabase function logs for `[MajorGithubWebhook]` error lines around the delivery timestamp.
- If the delivery failed (non-2xx), use "Redeliver" in GitHub's webhook UI to replay it without re-labelling.

### 2.6 First green end-to-end (core-loop smoke, bypass triage)

**Run this first** after initial setup (§1), before trusting any inbound path. It validates the *core loop* — claim → implementer → PR → finalize → `ready-for-review` — in isolation, bypassing the inbound triage pipeline (validated separately in §2.7). A Brief is seeded directly at `ready-for-agent`, so triage and the path-blocker are out of the picture.

**Prerequisites.**

- Schema applied + edge functions deployed + secrets set (§1.2–§1.4). Schema applies via **direct `psql`, not `supabase db push`** — the dev project shares `_supabase_migrations` history with HealthBite, which blocks push (see §1.2 and the `20260509000004_gits_renames.sql` header).
- A **scratch** target repo the `major-shell-bot` PAT can clone + push to — **not** `healthbite`/`healix`. Create e.g. `MioMarker/major-smoke` with a `README.md` and a `dev` branch.
- A Shell `.env` (§1.7) with real tokens.

**Steps.**

1. Seed one `ready-for-agent` Brief (bypasses triage):

   ```bash
   SUPABASE_DB_PASSWORD='<dev-postgres-admin-password>' \
     scripts/seed-test-brief.sh --repo MioMarker/major-smoke
   ```

   Note the printed `brief_id`. The Brief carries a trivial one-line-README PRD.

2. Boot exactly one Shell (§1.7) — now memory-capped (`MAJOR_SHELL_MEMORY`, default 4g):

   ```bash
   scripts/shell-up.sh
   ```

   It registers via heartbeat, then within ~10s polls `major-claim-brief` and claims the Brief.

3. Watch the loop. In the UI (`/briefs`) the Brief moves `ready-for-agent` → `agent-running` → `ready-for-review`. Or via SQL:

   ```sql
   SELECT id, status, pr_url FROM major.briefs ORDER BY id DESC LIMIT 3;
   SELECT type, actor, created_at FROM major.events WHERE brief_id = <brief_id> ORDER BY created_at;
   ```

4. Confirm the artifacts:

   - A PR on the scratch repo (authored by `major-shell-bot`) targeting `dev` with the one-line README change.
   - `briefs.status = 'ready-for-review'` and `pr_url` populated.
   - A `git-change` row in `major.brief_artifacts` for the Run.
   - Events end with `run-ended` (outcome `succeeded`) → `status-transitioned` to `ready-for-review`.

**Pass criterion:** the Brief reaches `ready-for-review` with a PR and the Run's `tachikoma-implementer` verification is `pass`. That is a green core loop.

**If it stalls:**

- Stuck `agent-running`, no progress → `docker logs shell-A`. Usual causes: clone failed (PAT lacks repo access) or Claude auth missing (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`).
- Bounced to `ready-for-human` → a required verification failed; inspect `major.verification_results` for the Run + the Tachikoma transcript.
- Returned to `ready-for-agent` after ~5 min with no Shell progress → lease expired (Reaper swept it); the Shell died or hung — check container logs.
- No claim at all → confirm the Shell registered (`SELECT * FROM major.shells;`) and the Brief is `ready-for-agent` with a non-null `git_repository_ref`.

After this passes, validate the inbound triage pipeline via §2.7.

### 2.7 Inbound trigger smoke test

Use this procedure to confirm that the end-to-end inbound pipeline — GitHub issue → `needs-triage` label → Triage Session → auto-triage → Brief — is functioning. Run it after initial setup, after webhook re-registration, or any time you suspect the inbound path is broken.

**Prerequisites.**

- The `major-github-webhook` function is deployed and the webhook is registered on the target repo (§1.4 and §1.6).
- `GITHUB_WEBHOOK_SECRET` is set in Supabase secrets (§1.3).
- A test GitHub issue is open on one of the watched repos (`MioMarker/major`, `MioMarker/healthbite`, or `MioMarker/healix`). Create one now if needed; the title and body do not matter for smoke purposes.

**Trigger the pipeline.** Add the `needs-triage` label to the test issue (either at creation time or via the Labels panel). GitHub fires an `issues.labeled` event to the webhook endpoint.

---

**Check 1 — Webhook delivery received and acknowledged.**

Open the repo's webhook delivery log (GitHub → Settings → Webhooks → the Major webhook → Recent Deliveries). The most recent `issues` event should show `200 OK`. If it shows a non-200 or a timeout, the function is unreachable or the signature check failed — confirm `GITHUB_WEBHOOK_SECRET` matches the value registered on the webhook and that the function is deployed.

Confirm the Event row landed in the Cyberbrain:

```sql
SELECT id, type, actor, payload, created_at
FROM major.events
WHERE type = 'triage-session-created'
ORDER BY created_at DESC
LIMIT 5;
```

Expected: at least one row with `actor = 'integration:github'` and `payload` containing `source_issue_repo` and `source_issue_number` matching your test issue.

---

**Check 2 — Triage Session created with inbound metadata.**

```sql
SELECT id, status, initiator_actor, trigger_payload, created_at
FROM major.triage_sessions
WHERE initiator_actor = 'integration:github'
  AND trigger_payload->>'source_issue_repo' = '<owner>/<repo>'
  AND (trigger_payload->>'source_issue_number')::int = <issue_number>
ORDER BY created_at DESC
LIMIT 1;
```

Expected: one row with `status = 'open'`, `initiator_actor = 'integration:github'`, and `trigger_payload` containing the issue's URL, title, body, and author login. Record the `id` as `<session_id>` for the remaining checks.

If no row exists, the webhook handler's `handleIssue` path did not execute. Verify the label name is exactly `needs-triage` (case-sensitive) and the issue's repo is in the watched allowlist.

---

**Check 3 — Auto Triage processed and closed the Session.**

After labeling, the Triage Session sits `open` until `major-auto-triage-sessions` processes it. Trigger this step by clicking **Auto Triage** on the Triage Sessions page in the UI (`/triage`), or POST directly:

```bash
curl -X POST \
  -H "Authorization: Bearer <service-role-key>" \
  -H "X-Major-Shell-Id: smoke" \
  https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1/major-auto-triage-sessions
```

The `X-Major-Shell-Id` header is **required** for service-role callers — the auth helper (`_shared/auth.ts`) attributes the call to `shell:<id>`. Omitting it returns `500 Service-role caller must set X-Major-Shell-Id`. Any non-empty value works for smoke purposes. (The dev service-role key is the new `sb_secret_` format, so this function must stay `verify_jwt = false` — which it is.)

Then confirm the session is closed and the transcript has an auto-triage message:

```sql
SELECT id, status,
       transcript->-1 AS last_transcript_message
FROM major.triage_sessions
WHERE id = <session_id>;
```

Expected: `status = 'closed'` and the last transcript message has `role = 'agent'` with content describing what Brief was proposed.

---

**Check 4 — Change Set produced.**

```sql
SELECT cs.id    AS change_set_id,
       cs.decision,
       cs.needs_human_apply,
       cs.summary,
       count(op.id) AS op_count
FROM major.triage_change_sets cs
JOIN major.triage_change_operations op ON op.change_set_id = cs.id
WHERE cs.triage_session_id = <session_id>
GROUP BY cs.id, cs.decision, cs.needs_human_apply, cs.summary;
```

Expected: one row with `decision = 'proposed'` (or `'accepted'` if the RPC already ran), `op_count >= 2` (at minimum a `create-brief` op and a `set-ready-state` op). Record the `change_set_id`.

---

**Check 5 — Path-blocker decision resolved.**

```sql
SELECT op.id,
       op.operation_type,
       op.status,
       op.sequence_index
FROM major.triage_change_operations op
WHERE op.change_set_id = <change_set_id>
ORDER BY op.sequence_index;
```

Cross-reference with the Change Set's `needs_human_apply`:

- **`needs_human_apply = false` (auto-applied path):** all operations should show `status = 'applied'`. If any are still `'proposed'`, the `apply_change_set` RPC may have failed — check Supabase function logs for `[major-auto-triage-sessions] apply RPC failed`.
- **`needs_human_apply = true` (human-apply path):** all operations will be `'proposed'` and the Change Set appears in Pending QA (`/pending-qa`). A human must apply it before Briefs are created. For smoke purposes, confirm the Change Set appears in the UI and proceed to Check 6 only after manually applying.

---

**Check 6 — Brief created with correct source linkage and authorship.**

```sql
SELECT b.id             AS brief_id,
       b.status,
       b.source_issue_repo,
       b.source_issue_number,
       r.revision_number,
       r.author_actor
FROM major.briefs b
JOIN major.brief_content_revisions r ON r.id = b.current_revision_id
WHERE b.source_issue_repo = '<owner>/<repo>'
  AND b.source_issue_number = <issue_number>;
```

Expected:

- One row (or more if the Triage Tachikoma split the issue into multiple Briefs).
- `source_issue_repo` and `source_issue_number` match the test issue.
- `status = 'ready-for-agent'` (auto-apply path) or `'ready-for-triage'` (if still awaiting human apply).
- `author_actor = 'agent:triage-tachikoma'` — confirms that the Brief Content was attributed to the Triage Tachikoma, not to the human who pressed Apply (set by `apply_change_set` for GitHub-seeded sessions, per `20260513000000`). Note: `CLAUDE.md` and the `AUTO_TRIAGE_ACTOR` constant still say `major:auto-triage`; see #164 to canonicalize the name.

**All six checks passing confirms the full inbound pipeline is operational.**

If any check fails, emit a telemetry record in `major.telemetry_records` with `observation_type = 'external-system-error'` and the failed step, then file a GitHub issue titled `Security: inbound-trigger-check-<N>-failed` or the appropriate label so the post-incident review has a tracking record.

### Smoke test log

Record each execution of this procedure here with date, who ran it, outcome, and any corrective actions taken.

| Date | Who | Outcome | Notes |
|---|---|---|---|
| 2026-05-12 | Tachikoma implementer (run 10648, Brief 57) | Code review only — live test not run from sandbox | Verified webhook label constant `"needs-triage"`, `initiator_actor = "integration:github"`, and `trigger_payload` field names all match the Check 1–6 queries. Found §1.4 deploy loop was missing 14 functions added since initial authoring (including `major-auto-triage-sessions`, `major-rearm-brief`, `major-record-telemetry`, and others); deploy list corrected in this PR. A live end-to-end run against the dev environment should be performed manually to validate Check 3 (auto-triage session processing) before next Shell boot. |
| 2026-05-25 | Claude (core-loop smoke, §2.6 — NOT this inbound test) | GREEN — Brief 64 → `ready-for-review`, run 10655 succeeded, PR `MioMarker/major-smoke#1` | First live end-to-end run of the **core loop** (seed `ready-for-agent` Brief → claim → implementer → PR → finalize), bypassing triage. Surfaced + fixed two latent bugs the never-run pipeline hid: (1) `shell/Dockerfile` COPY omitted `repair-helpers.ts` → in-image `tsc` failed; (2) clone used `Authorization: Bearer`, which GitHub's git endpoint rejects for PATs → switched to HTTP Basic auth. `tachikoma-implementer` pass; ci-rollup skipped (no CI on scratch repo). The **inbound triage pipeline** (Checks 1–6 above) remains unvalidated — that's the next smoke. |
| 2026-05-25 | Claude (inbound smoke, §2.7) | GREEN (after 3 fixes) — all Checks 1–6 pass; issue #163 → Brief `ready-for-agent`, `author_actor = agent:triage-tachikoma` | First live inbound run. Surfaced + fixed: (1) `MioMarker/major` webhook lacked the `issues` event (added); (2) Check 3 curl missing required `X-Major-Shell-Id` header (fixed above); (3) migration drift — inbound attribution (#80 / `20260513000000`) was never applied to dev, and `20260512000001`+`20260513000000` carry a `classifications`-cast regression of `20260511000004`. Applied `20260513000000` + forward-fix `20260525000000` (cast) + `20260525000001` (`brief_paths_blocked`). See #164. Artifacts cleaned up. |

### 2.8 Monthly operator checklist

Run on the first business day of each month:

- Verify `major-shell-bot` PAT has not been revoked; rotate before expiration (per § 1.7.1).
- Confirm Supabase service-role key and `GITHUB_WEBHOOK_SECRET` are still the values stored in 1Password.
- Spot-check `major.telemetry_records` for unusual volumes of `github-rate-limited`, `eval-gate-signature-mismatch`, or `tachikoma-bash-observed (decision='denied')` records since the last check.

### 2.9 Retry budget

`briefs.max_attempts` caps the number of times a Brief is automatically re-queued after a failed Run. The default is `3`; Triage can override per-Brief via the `set-max-attempts` Change Operation.

**How it works.** Each Run carries a `runs.attempt_number`. On Run Finalization, if the Run failed and `attempt_number < max_attempts`, the Brief is automatically re-armed to `ready-for-agent` for a Repair Run — a second-attempt implementer that also receives diagnostics from the prior attempt. If `attempt_number >= max_attempts`, the Brief is routed to `ready-for-human` instead; the Human Handoff Event payload includes `retry_budget_exhausted: true` so operators can filter for this case.

**Re-arm as Repair (human override).** A human can bypass the cap from Brief Detail:

1. Open Brief Detail. Confirm the failures were transient or that the underlying issue has been fixed (content updated, environment repaired, etc.).
2. Click "Re-arm as Repair." This sets `status = 'ready-for-agent'` and schedules the next claim as `purpose = repair` — regardless of the current `attempt_number`. It does not reset the attempt counter; above-budget re-arms increment past `max_attempts`, governed only by the human decision to re-arm.
3. Record the reason in the UI prompt (or Brief Comments) so the audit trail reflects why the budget was overridden.

If the Brief continues to exhaust its budget after re-arms, edit the Content (new revision → Triage Change Set) to give the agent better guidance rather than re-arming indefinitely.

---

## 3. Eval gate

The HealthBite eval gate (`.github/workflows/eval-safety.yml`) runs on PRs touching `supabase/functions/chat-with-ai/**` or `eval/**`. It is **advisory**: failures show a red X on the PR but do not block merge.

Major's relationship to the eval gate:

- Major mirrors PR check status into `major.brief_artifacts` (the Pull Request artifact's `derived_facts`). The eval gate appears as one check among many.
- Major does **not** treat eval-gate red as a Run Finalization blocker. Sandbox-run `tsc --noEmit` and tests are required; the eval gate is decoration on top.
- The Briefs View shows an `eval-gate: red` badge on Briefs whose PR has an eval-gate failure. This is informational — humans see it before the QA Confirmed step.

If you see an eval-gate red badge on a `ready-for-review` Brief: open the PR, read the eval result, decide. If you accept: continue with QA confirmation. If the eval-gate finding is real: reject the Brief (`wontfix`) and create a new Brief to address the underlying safety regression.

The eval gate flips from advisory to blocking only via the Stage 1 Sprint 1 flip-rule in HealthBite's `.claude/rules/ai/evaluation-pipeline.md`. Major does not modify that decision.

---

## 4. Path-blocker config edits

The `path_blocker_config` table stores the protected globs and the mass-rerank threshold. Edits take effect on the next Triage Change Set apply.

### Through the UI

Settings → Path-Blocker. Add/remove globs from the list; adjust the mass-rerank threshold (default `5`). Save.

The UI calls a stored procedure that writes both the new config row and an Event. Always edit through the UI when possible.

### Through SQL

When the UI is unavailable or you need to script a change:

```sql
-- Read current config
SELECT * FROM major.path_blocker_config ORDER BY updated_at DESC LIMIT 1;

-- Apply a change (insert a new row; do NOT update in place — config is append-only audit)
INSERT INTO major.path_blocker_config (protected_globs, mass_rerank_threshold, updated_by)
VALUES (
  ARRAY[
    'supabase/functions/chat-with-ai/**',
    'eval/**',
    'supabase/migrations/**',
    '.claude/rules/**',
    'app.config.ts',
    '.github/workflows/**'        -- added
  ],
  5,
  '<your-user-id>'
);

-- Record an Event for the audit trail (Briefs don't drive this, so use a synthetic brief_id of the Major-meta Brief if one exists, else null with a dedicated event_type)
INSERT INTO major.events
  (brief_id, type, actor, idempotency_key, payload)
VALUES
  (null, 'path-blocker-config-updated', 'human:<your-user-id>',
   'pb-config-' || gen_random_uuid(),
   jsonb_build_object('reason', 'add github workflows to protected list',
                      'added', ARRAY['.github/workflows/**']));
```

Path-blocker config is append-only by convention. The current effective config is the most recent row.

---

## 5. Bootstrap data

Already shipped in `supabase/migrations/20260509000000_initial_schema.sql` as part of the schema apply:

- The initial `path_blocker_config` row, with the v1 protected globs from `SPEC.md`'s "Path-blocker rule" section and `mass_rerank_threshold = 5`.
- The two `artifact_type_contracts` rows for `git-change` (claim/produce/review/verify rules) and `triage-change-set` (apply rules).

If a fresh DB is missing these rows (e.g., a developer ran a partial migration), re-running `npx -y supabase db push` is idempotent — the seed inserts use `ON CONFLICT DO NOTHING`.

Do not author additional artifact type contracts in v1. New artifact types require an ADR (`docs/adr/`).

---

## 6. Switching HealthBite from main-as-integration to dev-as-integration

Major's adoption of HealthBite (and Healix, already on this model) requires HealthBite to use `dev` as the integration branch and `main` as the release branch. The mechanical steps:

1. **Create the `dev` branch off current `main`.**
   ```bash
   cd ~/Projects/healthbite
   git fetch origin
   git checkout main && git pull
   git checkout -b dev
   git push -u origin dev
   ```

2. **Mirror the `main` branch protection ruleset onto `dev`.** In GitHub Settings → Rules → Rulesets, duplicate the `main` ruleset and target `refs/heads/dev`. Ensure all the same checks remain: required PR, required code-owner review, no direct push, no force-push, linear history.

3. **Update `.github/CODEOWNERS` to target `dev`-bound PRs.** The existing CODEOWNERS file works regardless of target; verify both `@Pioneer18` and `@kuvekep14` are listed and there are no path-specific overrides that would carve one of them out.

4. **Update HealthBite's `.claude/rules/common/git-workflow.md` and `deploy-workflow.md`** to reflect "branch off `dev`, PR back to `dev`, release = `dev → main` merge." File this as a separate PR in HealthBite — it's out of scope for the Major repo's commits but is a follow-on for ADR 003.

5. **Communicate to Paul (`@kuvekep14`).** Two-dev rebuild of muscle memory: every PR retargets, every release becomes a deliberate `dev → main` merge.

6. **Update Major's `git_repository_ref` config (if any) for HealthBite Briefs** to use `dev` as `base_branch`. The default in `supabase/migrations/20260509000000_initial_schema.sql` is already `dev`; Briefs created before this switch may have `main` baked in — fix in place via SQL or via Triage Change Set on each affected Brief.

7. **Tag the cutover.** Annotated tag on the last `main`-based commit:
   ```bash
   git tag -a backend/2026-05-09-cutover -m "HealthBite switches to dev-as-integration; main becomes release"
   git push origin backend/2026-05-09-cutover
   ```

After cutover: verify by opening a trivial PR targeting `dev` and walking it through the new flow. The release path (`dev → main`) is exercised at the next mobile or backend release, not as part of the cutover itself.

---

## Running tests locally

Major has three test suites per ADR 020. A root `npm test` runs all three in sequence.

### Prerequisites

- **Deno** ≥ 1.40 — for the edge-function tests.
- **Node.js** ≥ 20 — for the Shell tests.
- **pgTAP** (optional) — for the RPC SQL tests. Install via `brew install pgtap` on macOS. Required in CI; skipped locally if `DATABASE_URL` is unset.
- Shell deps: `cd shell && npm install`

### One-shot

```bash
npm test          # runs pgTAP + Deno + Shell; pgTAP is skipped if DATABASE_URL unset
```

### Individual suites

```bash
# pgTAP (Postgres RPC tests) — requires a running Postgres with Major schema applied
DATABASE_URL=postgres://postgres:postgres@localhost:5432/major_test scripts/test-rpc.sh

# Deno tests (edge functions + shared helpers)
deno test --allow-none supabase/functions/

# Shell tests (Node.js behavioral tests)
cd shell && npm test
```

### Setting up Postgres for pgTAP locally

Using Supabase CLI with a local database:

```bash
npx -y supabase start          # starts a local Postgres + Supabase stack
npx -y supabase db push        # applies all migrations

# pg_prove reads DATABASE_URL — get the local connection string:
export DATABASE_URL=$(npx -y supabase status --output json | jq -r '.DB_URL')
scripts/test-rpc.sh
```

Or directly with Docker:

```bash
docker run -d --name major-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=major_test \
  -p 5432:5432 \
  supabase/postgres:15.1.0.117

export DATABASE_URL=postgres://postgres:postgres@localhost:5432/major_test

# Apply the schema
for f in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done

scripts/test-rpc.sh
```

### Test files reference

| Suite | Files | What's tested |
|---|---|---|
| pgTAP | `tests/rpc/*.test.sql` | claim_next_brief (F-06, F-07), finalize_run (F-11, F-12), apply_change_set (F-04, F-22), reaper_sweep |
| Deno | `supabase/functions/**/*.test.ts` | path-blocker glob matcher, webhook signature verification, handlePullRequest F-17, confirmQaCore F-19, sanitizer, github-issue ADR 011, reject-brief F-02 |
| Shell | `shell/*.test.ts` | Stream-JSON parser, planner gate, F-10 heartbeat-loss abort, F-14 sandbox cleanup, F-16 PR-exists detection |
