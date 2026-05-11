# Major — Failure Modes Catalog

The full catalog of how Major fails and how it recovers. Companion to `SPEC.md`'s "Failure modes" table (this file expands every row with detection mechanism, automated handling, and manual escalation criteria).

For incident response, start with `docs/runbook.md` § 2.2 (manual lease repair) and § 2.3 (re-running a failed Brief).

Vocabulary follows ADR 004 (Brief / Shell / Cyberbrain).

---

## 1. Shell crash mid-Run / heartbeat lapse

**What it looks like.** A Shell dies — host crashed, Docker daemon restarted, OOM, segfault — while owning a Run. The `runs` row remains `outcome='running'` with a stale `heartbeat_at`. The Brief stays in `agent-running` and is not eligible for claim.

**Detection.** `major-reaper` (`pg_cron`, every 60s) selects rows where `lease_expires_at < now()` and `outcome = 'running'`.

**Automated handling.** Reaper marks the Run cancelled with `cancellation_reason = 'lease-expired'`, emits a `system-run-cancelled` Event, transitions the Brief to `ready-for-agent` (clean retry path), and writes a Telemetry Record with the lapsed `shell_id`. The next eligible Shell picks up the Brief; the existing `major/brief-<id>` branch is reused — partial commits remain so the Tachikoma can resume from the prior state if useful.

**Manual escalation.** None expected. If reapings happen frequently (> 3 per hour) on the same `shell_id`: investigate the host. If reapings happen across many Shells: investigate the Supabase project (RLS errors on heartbeat writes can simulate a lease lapse).

---

## 2. Racing Shells on claim

**What it looks like.** Two Shells poll `major-list-briefs?status=ready-for-agent` and both attempt `major-claim-brief` on the same Brief simultaneously.

**Detection.** The Run Start Transaction is an atomic `UPDATE major.briefs SET status = 'agent-running' WHERE id = $1 AND status = 'ready-for-agent' RETURNING ...`. The loser's `UPDATE` returns 0 rows.

**Automated handling.** Loser receives `409 Conflict` from `major-claim-brief`, drops the candidate, and resumes polling. Winner continues the Run normally. The Single Active Run Rule (partial unique index on `runs(brief_id) where outcome='running'`) is the second line of defense if the first check ever has a bug.

**Manual escalation.** None. This is the expected behavior; it does not need monitoring.

---

## 3. Slow Shell (lease expires while alive)

**What it looks like.** A Shell is alive but slow — long sandbox CI loop, network stall — and its `lease_expires_at` passes before it next heartbeats. Reaper has already cancelled the Run and transitioned the Brief back. Meanwhile the slow Shell is still working.

**Detection.** Every Shell→Major API call (heartbeat, finalize-run) verifies the `runs.outcome` is still `'running'` and the lease still belongs to this `shell_id`.

**Automated handling.** The slow Shell's next API call sees `outcome != 'running'` (or a different `shell_id`, if a new claim was made), aborts gracefully, cleans up its sandbox, and emits a `shell-aborted-after-takeover` Telemetry Record. No Run Finalization Transaction is attempted; partial work on the branch persists for the new claimant.

**Manual escalation.** None expected. If the slow Shell cannot abort cleanly (e.g., the sandbox is wedged): the operator manually `docker kill`s the container and the host-restart logic recreates a fresh Shell with a new id.

---

## 4. Run reports duplicated

**What it looks like.** A Shell retries `major-finalize-run` after a network blip, sending the same finalization payload twice.

**Detection.** Idempotency Key on the finalize call: `(brief_id, 'run-ended', shell, run_id)`. Combined with the `runs.id` PK and the partial unique index, duplicate inserts conflict.

**Automated handling.** Second call returns `200 OK` with the same body as the first — the canonical Run Finalization Transaction outcome. No state change on retry.

**Manual escalation.** None.

---

## 5. Sandbox CI red

**What it looks like.** Tachikoma implementer runs `tsc --noEmit` and tests in the sandbox; tests fail. Implementer iterates: re-reads errors, edits, re-runs. Iteration budget exhausts before green.

**Detection.** `runImplementer` exit code; sandbox-run Verification Results recorded.

**Automated handling.** Run Finalization records the red Verification Results. Decision tree:

- Errors look transient (network flake, sandbox timeout) → Brief routed to `ready-for-agent` (clean retry; new Shell will pick up).
- Errors look like real code issues (type errors, test logic) → Brief routed to `ready-for-human` with a Human Handoff Event explaining "iteration budget exhausted; <N> tests still failing." Branch and partial commits remain.

**Manual escalation.** Human inspects the Brief Detail, decides whether to (a) edit Content with more guidance and re-route to `ready-for-agent` via Triage Change Set, (b) take over the branch manually and finish, or (c) reject (`wontfix`).

---

## 6. External CI never reports

**What it looks like.** Tachikoma pushes commits, opens PR, CI is configured to run on the repo — but the CI workflow never reports back. Webhook delivery missing or delayed.

**Detection.** `major-github-webhook` delivery monitoring (Telemetry Record per inbound delivery). PR row's `derived_facts` show no `check_run` events after a configurable interval (default 10 min).

**Automated handling.** The eval gate is advisory; missing CI status does not block Run Finalization. Brief still proceeds to `ready-for-review`. The Briefs View shows a `ci-pending` badge so humans see the missing data at QA-confirmation time.

**Manual escalation.** If many Briefs show `ci-pending`: the GitHub webhook may be misconfigured. Check the webhook delivery log on the GitHub repo settings page; redeliver missed events; verify `GITHUB_WEBHOOK_SECRET` matches.

---

## 7. Change Set partial apply

**What it looks like.** A Triage Change Set has 5 ops; op 3 fails (e.g., a relationship target Brief doesn't exist). Without a transaction, ops 1 and 2 would persist and ops 3-5 would be lost.

**Detection.** `major-apply-change-set` wraps all ops in a single Postgres transaction; any failure raises and rolls back.

**Automated handling.** All ops fail together. The Change Set's status moves to `apply-failed` with the error message attached. Caller sees `400` with the error. Idempotency keys on individual ops prevent partial duplicate apply on retry.

**Manual escalation.** Operator inspects the failure message, fixes the underlying issue (often: dangling relationship reference because target Brief was rejected), re-issues the Change Set apply through the UI. If the Change Set itself is malformed (LLM output bug): mark it superseded and start a new Triage Session.

---

## 8. PR collision (two Briefs merge same path)

**What it looks like.** Brief A's PR merges. Brief B's branch was based on `dev` before A merged; when B's PR is processed, the merge requires a rebase or has conflicts.

**Detection.** GitHub mergeability check; PR's `mergeable` field becomes `false`. Webhook updates the PR's `derived_facts.mergeable=false`.

**Automated handling.** None automated in v1 — Major does not auto-rebase. The Briefs View surfaces a `needs-rebase` badge on B. The Brief remains in `ready-for-review` (the Run already finalized) but the PR merge cannot proceed.

**Manual escalation.** The human reviewer either (a) manually rebases the branch and pushes (the Brief stays in `ready-for-review`), or (b) opens a Repair Run via the Brief Detail, which spawns a fresh Tachikoma to rebase the branch in a sandbox. The Repair Run may produce additional commits but does not transition Status — it only makes the PR mergeable again.

---

## 9. Path-blocker false positive

**What it looks like.** A safe Change Set is queued for human apply because `expected_paths` happens to glob-match a protected pattern, but the actual changes don't touch the sensitive concern.

**Detection.** None automated — relies on human catching it at apply time.

**Automated handling.** None. The path-blocker is deliberately conservative; false positives are accepted as a cost.

**Manual escalation.** Human reviews the queued Change Set, sees it's safe, applies it. If the same false positive happens repeatedly on a class of Briefs: open an issue to refine the protected globs and emit a Telemetry Record with `false_positive_glob` so the data informs future glob-list edits.

---

## 10. Path-blocker false negative

**What it looks like.** A Change Set auto-applies that should have required human apply — the touched paths weren't in the protected list, but the change is genuinely sensitive.

**Detection.** Caught downstream: reviewer Tachikoma flags it on PR review, or human catches it at QA Confirmation.

**Automated handling.** None at apply time. The reviewer Tachikoma's comments (advisory) and the human at QA are the safety net.

**Manual escalation.** Reject the Brief (`wontfix`) or human takes over the branch. After the incident: post-mortem updates the protected glob list (UI Settings → Path-Blocker, append the missed pattern) and a Telemetry Record is written to inform future audits.

---

## 11. Triage Session LLM error

**What it looks like.** The LLM call inside `major-send-triage-message` fails — timeout, 429, malformed response.

**Detection.** Caught by the function's try/catch; surfaces as `500` to the UI.

**Automated handling.** Triage Session is durable; transcript is persisted up to the failed message. User sees an error toast and can re-send. The retry is idempotent at the session level — the LLM is called fresh, but no DB writes happen until a successful response.

**Manual escalation.** None for transient errors. For sustained errors (LLM provider outage): pause Triage by hiding the "New Triage Session" button via a feature flag and notify users via the UI banner. Briefs already in motion are unaffected — Triage Sessions block intake, not running Briefs.

---

## 12. Reviewer Tachikoma fails

**What it looks like.** Phase 1 (implementer) succeeds; Phase 2 (reviewer) exits non-zero — e.g., the reviewer prompt errors out, `gh pr review` rejects auth, sandbox runs out of disk.

**Detection.** `runReviewer` return code; absent `major/review` status check on the PR.

**Automated handling.** Run still finalizes. Reviewer is advisory; absence of review is acceptable. The Briefs View shows a `no-review` badge on the Brief. A Telemetry Record captures the reviewer failure mode.

**Manual escalation.** None expected for individual failures. If `no-review` appears on > 20% of recent Briefs: investigate the reviewer prompt or the `gh` auth setup in the Shell image.

---

## 13. GitHub API rate limiting

**What it looks like.** Shell's `gh` calls or the webhook handler's outbound calls hit GitHub's rate limit. Symptoms: `403 Forbidden` with `X-RateLimit-Remaining: 0`, or `429 Too Many Requests`.

**Detection.** Response status checks in `shell/main.ts` and in `major-github-webhook`'s outbound paths. A Telemetry Record with `event=github-rate-limited` is written on detection.

**Automated handling.** Exponential backoff: `30s, 60s, 120s, 240s, 480s` (capped). Retries up to 5 times. Heartbeat continues during backoff so the lease doesn't expire.

**Manual escalation.** If backoff exhausts or the rate limit persists past `X-RateLimit-Reset`: the affected Brief is routed to `ready-for-human` with a Human Handoff Event citing rate-limit exhaustion. Rotate to a different fine-grained PAT or wait for the reset window. Persistent rate limiting across all Briefs implies fleet-wide PAT revocation or a GitHub status incident.

---

## 14. Supabase service-role key compromised

**What it looks like.** A service-role key leaks (committed to a public repo, copied into a Slack message, lost laptop).

**Detection.** Reported by a human, by GitHub's secret scanning, or by anomalous activity in the Supabase logs.

**Automated handling.** None — this is a security incident, not a runtime failure.

**Manual escalation.**
1. **Rotate immediately.** Supabase dashboard → Settings → API → Reset service-role key.
2. **Update edge function secrets.** `npx -y supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<new>`. Edge functions pick up new env vars on next cold start; redeploy to force.
3. **Rebuild the Shell image.** The key is baked into the running container's environment; existing containers must stop and restart with the new key. `docker stop` running Shells; relaunch with the updated env.
4. **Audit `major.events` and `major.telemetry_records`** for any actions attributed to non-human Actors during the exposure window. Reverse damaging actions if any.
5. **Open an issue post-incident** with: leak source, exposure window, rotation timeline, audit findings, prevention measures.

---

## 15. Tachikoma LLM API quota exhausted

**What it looks like.** Anthropic API returns `429` with `quota exhausted` consistently across all Tachikoma invocations.

**Detection.** Non-retryable `429` from Claude Code subprocess; Telemetry Record with `event=llm-quota-exhausted`.

**Automated handling.** Pause all Shells — they should poll, see no work to do, but stop attempting claims. Implemented via a kill-switch row in `major.shell_pool_state` (set `paused=true`); Shells check this flag every poll cycle.

**Manual escalation.** Active Briefs in `agent-running` are routed to `ready-for-human` via a fleet-wide System Run Cancellation when the kill-switch flips. Operator: top up the Anthropic account, lift the kill-switch (`UPDATE major.shell_pool_state SET paused = false`), then resubmit affected Briefs per § 2.3 of the runbook.

---

## 16. Eval gate signature mismatch

**What it looks like.** A PR check named `eval-safety` reports a status, but its identifying metadata (workflow file SHA, runner identity) doesn't match the expected eval-pipeline signature. Possible causes: a forked workflow, a bypass attempt, a CI misconfiguration.

**Detection.** `major-github-webhook`'s `check_run` handler validates the check's `head_sha` and the workflow file SHA against the registered eval workflow signature. Mismatch raises a `[GithubWebhook] eval-gate-signature-mismatch` Telemetry Record.

**Automated handling.** The check is **not** mirrored to the Brief's `derived_facts`. The Briefs View shows an `eval-gate: signature-mismatch` warning. Run Finalization is unaffected (eval is advisory) but the badge is more alarming than `red`.

**Manual escalation.** Investigate immediately. Never silently bypass — the signature mismatch is a security signal. Possible legitimate cause: the eval workflow file was deliberately changed in a PR; in that case, the new signature must be registered in `major.eval_signatures` before mismatches stop. Possible illegitimate cause: someone is trying to spoof a green eval gate; treat as an attempted policy bypass and audit the actor's other actions.

---

## 17. Two Tachikoma phases racing in same sandbox

**What it looks like.** `runImplementer` and `runReviewer` are running concurrently in the same sandbox, modifying the same files.

**Detection.** Should be impossible by design: `shell/main.ts` runs the two phases sequentially in `await`-ordered code, and there is no path that spawns both. If it ever happens, sandbox file locks or a sentinel file (`/work/.major/phase-active.lock`) detects it.

**Automated handling.** Hard-fail the Shell. The current Run is cancelled (System Run Cancellation, route to `ready-for-human` because the sandbox state is unsafe). A `[Shell] phase-race-detected` Telemetry Record is emitted with the `shell_id`, the Brief id, and stack traces from both phases if available. Container exits non-zero so the host's restart logic spawns a fresh Shell with a clean filesystem.

**Manual escalation.** This is a "should-never-happen." If it ever does: open an issue immediately, attach the Telemetry Records, and audit the Shell orchestration code for the lifecycle bug. Treat as a high-severity defect — Brief state in the affected sandbox cannot be trusted; the affected Brief must be inspected by a human before any further Run.

---

## 18. Source-issue close failed after PR merge (ADR 007)

**What it looks like.** The PR-merge webhook fired and transitioned the Brief to `done` correctly, but the linked GitHub issue (recorded in `briefs.source_issue_repo` + `briefs.source_issue_number`) is still open. Symptom: the issue stays on the issue tracker after the resolving PR has merged.

**Detection.** `[major-github-webhook]` log line with `issue-close-failed`, payload includes the source issue coordinates and the GitHub API error. The Brief itself is correctly transitioned; only the outbound side effect failed.

**Automated handling.** None. Per ADR 007, the issue-close failure is logged but does not abort the Brief transition — the canonical state (Brief done) is correct; the issue close is a best-effort downstream effect. Eventual consistency.

**Manual escalation.** Operator manually closes the issue with a comment linking to the merged PR and the Brief. If failures cluster (multiple issues stuck open), check:
1. **Token scope.** Per `docs/runbook.md` § 1.7.1, the token used by `major-github-webhook` (env var `GITHUB_APP_TOKEN`) needs `Issues: Write` on each dependent repo. A PAT rotated without this scope produces this failure mode silently.
2. **GitHub rate limit.** Same as failure mode § 13.
3. **Repo access.** If the source issue is in a repo Major no longer has token access to (revoked install, deleted repo), the close call returns 404 — manual cleanup only.

If the failure is recurring and operationally painful, the v2 fix is a polling reconciler that sweeps recently-merged Briefs and retries their pending issue-close calls. Out of scope for v1; this failure-mode entry is the manual fallback.

**Sub-case: wontfix-close (`state_reason: "not_planned"`).** When a Brief is rejected as `wontfix` via the UI, the source GitHub issue is closed with `state_reason: "not_planned"` (rather than `"completed"`). This is distinct from the normal merge-triggered close (which uses `"completed"`).

Observable difference for operators: the issue appears under GitHub's "Not planned" closed filter, not the "Completed" filter. Search and triage dashboards that filter on `state_reason` will see these issues separately from successfully-resolved ones.

If the issue is still open after a `wontfix` rejection: follow the same token-scope and rate-limit checks as the main §18 escalation path above. When closing manually, pass `state_reason: "not_planned"` to preserve the semantic distinction.

---

## 19. Tachikoma bash command denied by Phase 2 deny list (ADR 008)

**What it looks like.** A Tachikoma `Bash` invocation is refused by Claude Code's `permissions.deny` enforcement (one of the 8 patterns in `shell/sandbox-claude-settings.json`). The Tachikoma sees the refusal in its tool-result; depending on the Run's progress, it may park-for-human, retry with a different command, or end the Run with an unrecoverable failure.

**Detection.** Denied commands appear in `major.telemetry_records` as `observation_type='tachikoma-bash-observed'` with `payload.decision='denied'` and `payload.matched_rule=<rule>`. For `permissions.deny` blocks (ADR 008), `matched_rule` is the matched glob pattern. For hook-level blocks (ADR 009), `matched_rule` is `'ad-hoc-package-install'`.

**Automated handling.** None — the deny is the handling. The Run continues; the Tachikoma may recover or may park.

**Manual escalation.**
1. **Confirm the deny was correct.** Read the denied command. If it was a genuine policy violation (force-push, `npm publish`, etc.), the system worked as intended — no action needed beyond watching for whether the Tachikoma adapts or parks.
2. **If the deny was a false-positive** (a legitimate command the rule shouldn't have blocked), narrow the rule and redeploy:
   - Edit `shell/sandbox-claude-settings.json` to express the carve-out (allow rules don't override deny in Claude Code's matcher; the fix is to narrow the deny pattern itself).
   - Open a follow-up ADR if the carve-out reflects a policy change, not just a pattern fix.
   - Rebuild + redeploy the Shell image.
3. **If the deny pattern is structurally wrong** (e.g. matches commands the docs say it shouldn't), open an issue immediately and consider an emergency PR to remove the rule pending investigation.

The remaining deferred categories from ADR 008 (`pipe-to-shell`, `sudo`) are NOT covered by the deny list or the hook — denial of those depends on container isolation (for `pipe-to-shell`) and operator vigilance (for `sudo`). If a Tachikoma runs one of those and causes damage, that is a different failure mode (pre-Phase-2 surface area).

**Sub-case: `matched_rule='ad-hoc-package-install'` (ADR 009).** Ad-hoc package installs (`npm install <pkg>`, `yarn add <pkg>`, `pnpm add <pkg>`, `bun add <pkg>`) are caught by the audit hook discriminator; the hook emits a `decision='denied'` Telemetry Record and `exit 2`, blocking the Bash invocation before `permissions.deny` is evaluated. The Tachikoma receives a human-readable denial message on stderr. The Run continues; the Tachikoma may park-for-human faster or adapt to not needing the install. If the block was a false-positive (a Brief whose `expected_paths` includes `package.json` and whose work legitimately requires adding a dep), split the dep-add into its own Brief with `package.json` + the relevant lockfile in `expected_paths`, per ADR 009 § "Operator path for legitimate package installs." To audit denied installs:

```sql
select run_id, payload->>'command', created_at
from major.telemetry_records
where payload->>'matched_rule' = 'ad-hoc-package-install'
order by created_at desc;
```

---

## 20. Resolution comment / close partial failures

Introduced by the `_shared/github-issue.ts` helper (Issue #3 / ADR 011). When a Brief reaches a terminal state, Major attempts two outbound GitHub calls: post a resolution comment, then close the issue. Either call can fail independently.

**Sub-case A: Resolution comment failed, close succeeded.**

**What it looks like.** The issue is closed on GitHub but the resolution comment was not posted. Symptom: issue is in a `closed` state (visible under the resolved filter) but has no closing comment from the Major bot.

**Detection.** `[MajorGithubWebhook]` log line `resolution-comment-failed` alongside a successful `issue-close` log. A Telemetry Record with `observation_type='outbound-partial-failure'` and `payload.failed_step='comment'` is written.

**Automated handling.** None. The issue is already closed; the failure is a cosmetic gap only.

**Manual escalation.** Manually post the resolution comment on the issue (link to the merged PR and the Brief). Do not re-close the issue — it is already closed.

---

**Sub-case B: Close failed, resolution comment succeeded.**

**What it looks like.** The resolution comment was posted on the GitHub issue, but the issue remains open. Symptom: the issue shows a bot comment documenting the resolution but is still in the `open` state.

**Detection.** `[MajorGithubWebhook]` log line `issue-close-failed` alongside a successful `resolution-comment` log. A Telemetry Record with `observation_type='outbound-partial-failure'` and `payload.failed_step='close'` is written.

**Automated handling.** None. Per ADR 011, the issue-close is a best-effort downstream effect; failure is logged but does not abort the Brief transition.

**Manual escalation.** Manually close the issue. It is safe to do so — the resolution comment is already posted and documents the resolution. Follow the same token-scope and rate-limit checks as §18.
