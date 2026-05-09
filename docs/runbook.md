# Major — Operational Runbook

How to set Major up, run it day-to-day, and handle the situations that come up. Companion to `SPEC.md` (architecture) and `docs/failure-modes.md` (catalog of what can go wrong).

This runbook assumes the dev Supabase project (`nuihvxluxdpdjgkvtdih.supabase.co`) is the target. There is no production Major project in v1 — Major itself is dev-only; the systems it drives (HealthBite, Healix) have their own production environments.

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

This creates the `major.*` schema, all tables in `db/0001_initial_schema.sql`, the seed `path_blocker_config` row, and the seed `artifact_type_contracts` rows (`git-change`, `triage-change-set`).

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
          major-apply-change-set major-list-items major-get-item major-claim-item \
          major-finalize-run major-heartbeat major-github-webhook major-confirm-qa \
          major-reject-item major-start-auto-triage major-reaper; do
  npx -y supabase functions deploy "$fn"
done
```

Order doesn't matter; each function is independent. The reaper is invoked by `pg_cron`; the deploy command publishes the function — schedule registration is in the migration.

### 1.5 Build and push the Runner image

```bash
cd ~/Projects/major/runner
docker build -t major-runner:latest .

# Tag + push if/when we adopt a registry; v1 runs locally
```

The Runner image must include: `deno`, `node20`, `gh`, `git`, and the Claude Code CLI. It is rebuilt on every Runner code change; it is never patched in place.

### 1.6 Register GitHub webhooks on dependent repos

For each repo Major drives (`MioMarker/healthbite`, `MioMarker/healix`):

1. Settings → Webhooks → Add webhook.
2. Payload URL: `https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1/major-github-webhook`
3. Content type: `application/json`.
4. Secret: same value as `GITHUB_WEBHOOK_SECRET` from step 1.3.
5. Events: `Pull requests`, `Check runs`, `Pushes`. (The handler ignores other events; subscribing to fewer events is the safer default.)
6. Active: yes.

After adding, push a no-op commit on the repo and confirm a `push` event lands in the webhook delivery log + a Telemetry Record appears in `major.telemetry_records`.

### 1.7 Boot a Runner Instance

```bash
docker run --rm \
  -e SUPABASE_URL=https://nuihvxluxdpdjgkvtdih.supabase.co \
  -e SUPABASE_ANON_KEY=<anon> \
  -e SUPABASE_SERVICE_ROLE_KEY=<service-role> \
  -e GITHUB_TOKEN=<fine-grained-PAT-with-repo-write-on-healthbite-and-healix> \
  -e ANTHROPIC_API_KEY=<key> \
  -v $HOME/.major/runner-1:/work \
  major-runner:latest
```

The Runner registers itself in `major.runner_instances` on boot, then enters the main loop.

---

## 2. Day-to-day operations

### 2.1 Monitoring runs via the UI

The Items View (default at `/`) lists all Items by Status. Filter on `agent-running` to see active Runs; filter on `ready-for-review` for Items awaiting human QA; filter on `ready-for-human` for stuck Items needing intervention.

Item Detail (`/items/<id>`) shows: current Content revision, full Events log, every Run with its outcome and Verification Results, all produced Artifacts (with PR links), and the relationship graph.

For at-a-glance Runner health: Settings → Runner Pool. Shows each `runner_instances` row with last heartbeat. Stale heartbeats (> 90s) are flagged; > 5 min triggers Lease-Expiry Reaper alerts.

### 2.2 Manual lease repair

Sometimes a Runner crashes in a way the reaper hasn't caught yet, leaving an Item in `agent-running` with a dead lease. Manual repair:

```sql
-- Identify the stuck Run
SELECT id, work_item_id, runner_instance_id, lease_expires_at
FROM major.runs
WHERE outcome = 'running' AND lease_expires_at < now() - interval '5 minutes';

-- Cancel the Run (System Run Cancellation, clean retry path)
UPDATE major.runs
SET outcome = 'cancelled',
    cancellation_reason = 'manual-repair',
    finalized_at = now()
WHERE id = '<run-id>';

-- Reset the Item to ready-for-agent (clean retry)
UPDATE major.work_items
SET status = 'ready-for-agent'
WHERE id = '<work-item-id>';

-- Record the manual intervention as an Event for audit
INSERT INTO major.events
  (work_item_id, event_type, source_actor, source_actor_id, idempotency_key, payload)
VALUES
  ('<work-item-id>', 'system-run-cancelled', 'human', '<your-user-id>',
   'manual-repair-' || gen_random_uuid(),
   jsonb_build_object('reason', 'manual-repair', 'run_id', '<run-id>'));
```

Run all four statements in a single transaction (`BEGIN;` … `COMMIT;`). Without the Event, the audit trail is broken; without the status update, the Reaper will keep firing.

If the situation looks unsafe to retry (e.g., the Runner committed bad code that's now in `develop`), set the Item to `ready-for-human` instead of `ready-for-agent`.

### 2.3 Re-running a failed Item

An Item that failed and was routed to `ready-for-human` (Run Finalization with Human Handoff) is intentionally stuck. To resubmit it:

1. Open Item Detail. Read the most recent Run's Events and Verification Results to understand what went wrong.
2. If the issue is content (PRD missing detail, expected_paths wrong): edit Content → new Content Revision → Triage Change Set → re-apply path-blocker → Status returns to `ready-for-agent`.
3. If the issue is environmental (transient sandbox error, GitHub flake): no Content change needed. Run this:

```sql
UPDATE major.work_items SET status = 'ready-for-agent' WHERE id = '<id>';

INSERT INTO major.events
  (work_item_id, event_type, source_actor, source_actor_id, idempotency_key, payload)
VALUES
  ('<id>', 'human-resubmit', 'human', '<your-user-id>',
   'resubmit-' || gen_random_uuid(),
   jsonb_build_object('reason', 'transient-failure', 'previous_run_id', '<run-id>'));
```

Never reset an Item to `ready-for-agent` without recording an Event — the audit trail and the lifecycle invariants depend on it.

### 2.4 Inspecting the Events log

```sql
-- Most recent 50 events across all Items
SELECT created_at, work_item_id, event_type, source_actor, payload
FROM major.events
ORDER BY created_at DESC
LIMIT 50;

-- Events for a single Item
SELECT created_at, event_type, source_actor, payload
FROM major.events
WHERE work_item_id = '<id>'
ORDER BY created_at ASC;

-- Find a stalled Run by event type
SELECT *
FROM major.events
WHERE event_type = 'run-started'
  AND work_item_id NOT IN (
    SELECT work_item_id FROM major.events WHERE event_type = 'run-ended'
  );
```

Telemetry Records live in `major.telemetry_records` and are queried similarly. Events drive lifecycle; Telemetry is observation only.

---

## 3. Eval gate

The HealthBite eval gate (`.github/workflows/eval-safety.yml`) runs on PRs touching `supabase/functions/chat-with-ai/**` or `eval/**`. It is **advisory**: failures show a red X on the PR but do not block merge.

Major's relationship to the eval gate:

- Major mirrors PR check status into `major.work_item_artifacts` (the Pull Request artifact's `derived_facts`). The eval gate appears as one check among many.
- Major does **not** treat eval-gate red as a Run Finalization blocker. Sandbox-run `tsc --noEmit` and tests are required; the eval gate is decoration on top.
- The Items View shows an `eval-gate: red` badge on Items whose PR has an eval-gate failure. This is informational — humans see it before the QA Confirmed step.

If you see an eval-gate red badge on a `ready-for-review` Item: open the PR, read the eval result, decide. If you accept: continue with QA confirmation. If the eval-gate finding is real: reject the Item (`wontfix`) and create a new Item to address the underlying safety regression.

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
SELECT * FROM major.path_blocker_config ORDER BY created_at DESC LIMIT 1;

-- Apply a change (insert a new row; do NOT update in place — config is append-only audit)
INSERT INTO major.path_blocker_config (protected_globs, mass_rerank_threshold, edited_by)
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

-- Record an Event for the audit trail (Items don't drive this, so use a synthetic work_item_id of the Major-meta Item if one exists, else null with a dedicated event_type)
INSERT INTO major.events
  (work_item_id, event_type, source_actor, source_actor_id, idempotency_key, payload)
VALUES
  (null, 'path-blocker-config-updated', 'human', '<your-user-id>',
   'pb-config-' || gen_random_uuid(),
   jsonb_build_object('reason', 'add github workflows to protected list',
                      'added', ARRAY['.github/workflows/**']));
```

Path-blocker config is append-only by convention. The current effective config is the most recent row.

---

## 5. Bootstrap data

Already shipped in `db/0001_initial_schema.sql` as part of the schema apply:

- The initial `path_blocker_config` row, with the v1 protected globs from `SPEC.md`'s "Path-blocker rule" section and `mass_rerank_threshold = 5`.
- The two `artifact_type_contracts` rows for `git-change` (claim/produce/review/verify rules) and `triage-change-set` (apply rules).

If a fresh DB is missing these rows (e.g., a developer ran a partial migration), re-running `npx -y supabase db push` is idempotent — the seed inserts use `ON CONFLICT DO NOTHING`.

Do not author additional artifact type contracts in v1. New artifact types require an ADR (`docs/adr/`).

---

## 6. Switching HealthBite from main-as-integration to develop-as-integration

Major's adoption of HealthBite (and Healix, already on this model) requires HealthBite to use `develop` as the integration branch and `main` as the release branch. The mechanical steps:

1. **Create the `develop` branch off current `main`.**
   ```bash
   cd ~/Projects/healthbite
   git fetch origin
   git checkout main && git pull
   git checkout -b develop
   git push -u origin develop
   ```

2. **Mirror the `main` branch protection ruleset onto `develop`.** In GitHub Settings → Rules → Rulesets, duplicate the `main` ruleset and target `refs/heads/develop`. Ensure all the same checks remain: required PR, required code-owner review, no direct push, no force-push, linear history.

3. **Update `.github/CODEOWNERS` to target `develop`-bound PRs.** The existing CODEOWNERS file works regardless of target; verify both `@Pioneer18` and `@kuvekep14` are listed and there are no path-specific overrides that would carve one of them out.

4. **Update HealthBite's `.claude/rules/common/git-workflow.md` and `deploy-workflow.md`** to reflect "branch off `develop`, PR back to `develop`, release = `develop → main` merge." File this as a separate PR in HealthBite — it's out of scope for the Major repo's commits but is a follow-on for ADR 003.

5. **Communicate to Paul (`@kuvekep14`).** Two-dev rebuild of muscle memory: every PR retargets, every release becomes a deliberate `develop → main` merge.

6. **Update Major's `git_repository_ref` config (if any) for HealthBite Items** to use `develop` as `base_branch`. The default in `db/0001_initial_schema.sql` is already `develop`; Items created before this switch may have `main` baked in — fix in place via SQL or via Triage Change Set on each affected Item.

7. **Tag the cutover.** Annotated tag on the last `main`-based commit:
   ```bash
   git tag -a backend/2026-05-09-cutover -m "HealthBite switches to develop-as-integration; main becomes release"
   git push origin backend/2026-05-09-cutover
   ```

After cutover: verify by opening a trivial PR targeting `develop` and walking it through the new flow. The release path (`develop → main`) is exercised at the next mobile or backend release, not as part of the cutover itself.
