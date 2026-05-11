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
for fn in major-create-triage-session major-send-triage-message major-finalize-triage-session \
          major-apply-change-set major-list-briefs major-get-brief major-claim-brief \
          major-finalize-run major-heartbeat major-github-webhook major-confirm-qa \
          major-reject-brief major-start-auto-triage major-reaper; do
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
5. Events: `Issues`, `Pull requests`, `Check runs`, `Pushes`. (The handler ignores other events; subscribing to fewer events is the safer default. `Issues` is required for the inbound `major:triage` label trigger per ADR 010.)
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

### 1.7.1 GitHub PAT scope

The fine-grained PAT used for `GITHUB_TOKEN` (Shell) and the equivalent token used by `major-github-webhook` for outbound calls (`GITHUB_APP_TOKEN` — set via `supabase secrets set`) must grant the following on each dependent repo (`MioMarker/healthbite`, `MioMarker/healix`):

| Permission | Used by | Why |
|---|---|---|
| `Contents: Write` | Shell | Push branches, create commits |
| `Pull requests: Write` | Shell | Open / update PRs |
| `Actions: Read` | Shell | Read CI status |
| `Issues: Write` | `major-github-webhook` (ADR 007) | Close source GitHub issue + post linking comment when the PR-merge webhook fires for a Brief with `briefs.source_issue_*` populated |

Tokens have an expiration; rotation is part of the operator's monthly checklist. After rotation, update the Shell `.env` AND `npx -y supabase secrets set GITHUB_APP_TOKEN=<new-token>` so the webhook handler also picks up the new value.

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

### 2.5 Inbound issue trigger (`major:triage` label)

Major can automatically seed a Triage Session from a GitHub issue. The trigger is opt-in: adding the `major:triage` label to an issue on any watched repo (`MioMarker/major`, `MioMarker/healthbite`, `MioMarker/healix`) fires an Auto Triage Run. Both `issues.opened` (if the label is pre-set on the issue at creation) and `issues.labeled` (label added after opening) trigger the flow.

**Default OFF.** Only labeled issues are triaged; unlabeled issues are ignored.

**What happens.**
1. The webhook handler (`major-github-webhook`) receives the `issues` event and validates it (repo allowlist, `sender.type === "User"` — bots are filtered out, per ADR 010).
2. Handler POSTs to `major-create-triage-session` with the issue body as the seed and `source_issue_*` coordinates populated on the eventual Brief.
3. The Triage Tachikoma runs an Auto Triage Run (`purpose=triage`), reads the issue body as Content under the Trust Boundary, and produces a Change Set.
4. The path-blocker (ADR 002) decides whether the Change Set auto-applies or queues for human apply — same as any Triage Session.

**Idempotency.** Relabeling an already-triaged issue creates a new Session only if the prior Session is finalized. An in-flight Session is not re-triggered.

**Monitoring.** Resulting Triage Sessions appear in the UI triage list. Navigate to the Session's detail page to see the source issue link.

**Cancelling an unwanted Session.** Removing the `major:triage` label does NOT cancel an in-flight Session — the Session is durable once seeded. If the resulting Brief is unwanted, reject it via `major-reject-brief` (Brief Detail → Reject).

**Prerequisites.** The `Issues` event must be checked on the GitHub webhook for each watched repo (§ 1.6). Without it, the webhook handler never receives the `issues` event.

### 2.6 Retry budget and Re-arm-as-Repair

Each Brief carries a `max_attempts` counter (default `3`) that caps automatic retries. When a Run finalizes as failed and the Brief reaches `ready-for-human`, the orchestrator checks:

- If `attempt_number < max_attempts`: the Brief is automatically re-armed to `ready-for-agent` as a **Repair Run** (`runs.purpose='repair'`). The Repair Tachikoma receives the failed Run's Verification Results and a transcript excerpt so it can attempt a different approach.
- If `attempt_number = max_attempts` (budget exhausted): the Brief parks at `ready-for-human` for human intervention. A `retry-budget-exhausted` Telemetry Record is emitted (ADR 014). Query via:

```sql
SELECT *
FROM major.telemetry_records
WHERE observation_type = 'retry-budget-exhausted'
ORDER BY created_at DESC;
```

**Counter reset.** `attempt_number` resets to 1 when Triage creates a new Content Revision. A meaningfully revised Brief gets fresh attempts.

**Above budget.** Brief parks at `ready-for-human`. See § 2.3 for the manual re-run path.

**Human override.** The Brief Detail UI "Re-arm as Repair" button bypasses the budget — it always fires a Repair Run regardless of `attempt_number`. Use this when the failure was environmental (transient sandbox error, network flake) and you don't want to wait for a content revision.

To inspect retry state for a specific Brief:

```sql
SELECT b.id, b.max_attempts, r.attempt_number, r.outcome
FROM major.briefs b
JOIN major.runs r ON r.brief_id = b.id
WHERE b.id = '<id>'
ORDER BY r.started_at DESC
LIMIT 1;
```

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
