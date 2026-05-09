# Major Runner Instance

Long-lived Docker container that polls Major for `ready-for-agent` Work Items, claims one at a time, and runs Tachikoma (Claude Code) phases against a sandboxed clone of the target repository.

One container = one Runner Instance. To scale parallelism, run N containers with distinct `RUNNER_ID` values.

See `~/Projects/major/SPEC.md` §Runner architecture for the conceptual model.

## Build

```sh
cd ~/Projects/major/runner
docker build -t major-runner .
```

The build:

1. Installs `git`, `gh`, Deno, Node 20.
2. Installs the Claude Code CLI for the unprivileged `agent` user.
3. Runs `npm install` against `package.json`.
4. Compiles the TypeScript daemon with `tsc` to `dist/`.

## Runtime choice

**Node 20 + TypeScript** for `main.ts` and `tachikoma.ts` (compiled at image build time). Reasons:

- Mature `child_process.spawn` semantics for managing the Claude Code CLI subprocess (clean stdout/stderr piping, SIGTERM-on-timeout).
- Native `fetch` (Node ≥ 18) for Major API calls; no extra deps.
- `npm` lockfile + `tsc --noEmit` matches the existing AGENTS.md verification ritual; no Deno permission flags to manage.
- The Tachikoma subprocess is the Claude Code CLI itself — that runtime is independent of the daemon's runtime.

Deno is still installed in the image because target repos (HealthBite eval pipeline) call `deno task ...` from inside the sandbox.

## Run

```sh
docker run -d \
  --name runner-A \
  --restart unless-stopped \
  -e RUNNER_ID=runner-A \
  -e MAJOR_API_BASE_URL="https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1" \
  -e SUPABASE_AUTH_TOKEN="<runner service-account JWT>" \
  -e GITHUB_TOKEN="<gh PAT or installation token with PR + commit + status:write>" \
  -e CLAUDE_API_KEY="<sk-ant-...>" \
  major-runner
```

Multiple runners — run side-by-side with different `RUNNER_ID`s:

```sh
docker run -d --name runner-A -e RUNNER_ID=runner-A ... major-runner
docker run -d --name runner-B -e RUNNER_ID=runner-B ... major-runner
```

The atomic claim path (`major-claim-item`) handles the race; only one runner wins each Work Item.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `RUNNER_ID` | yes | Unique id for this container; used as the row id in `major.runner_instances`. Must be stable across restarts of the same container. |
| `MAJOR_API_BASE_URL` | yes | Supabase functions root (no trailing slash). E.g. `https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1`. |
| `SUPABASE_AUTH_TOKEN` | yes | Bearer token for Major API calls. Must satisfy the `runner` actor RLS policy. |
| `GITHUB_TOKEN` | yes | For `gh` auth inside the sandbox (PR create, status checks, CI poll). Needs `repo`, `pull_requests:write`, `statuses:write`. |
| `CLAUDE_API_KEY` | yes | Anthropic API key the Claude Code subprocess consumes. Mapped to `ANTHROPIC_API_KEY` for the subprocess env. |
| `IMAGE_TAG` | no | Recorded in `runner_instances.metadata.imageTag` for provenance. |

## What happens on boot

1. `main.ts` reads env, exits with code 2 if anything is missing.
2. Calls `POST major-heartbeat` once with `initial: true` — this is where `runner_instances` is upserted.
3. Spawns a 30s heartbeat thread (renews `heartbeat_at` and, if a Run is active, the Run's lease).
4. Enters the main loop:
   - `POST major-claim-item`. If no work, sleep 10s, repeat.
   - On claim: `git clone` the target repo to `/work/<repo-name>/`, checkout `major/work-item-<id>`.
   - **Phase 1** — implementer Tachikoma (`runSandboxAgent({ role: "implementer", ...})`).
   - Wait for CI on the resulting PR (poll `gh pr checks` every 30s, timeout 20 min).
   - **Phase 2** — reviewer Tachikoma (only if implementer succeeded with a PR).
   - `POST major-finalize-run` with verifications + artifacts + telemetry + outcome + next Item status.
   - Wipe `/work/<repo-name>/`, loop.

## Sandbox isolation strategy

**Each Item gets a fresh `/work/<repo-name>/`**, cloned at claim time and removed at finalize time. The container's filesystem is the only sandbox boundary; we don't run Items in nested containers.

`/work/.major/` is the per-Run scratch directory, used by the daemon to drop files the Tachikoma reads:

- `/work/.major/item.json` — Work Item snapshot.
- `/work/.major/implementer-output.json` — Phase 1 result, read by Phase 2.
- `/work/.major/telemetry.jsonl` — telemetry the Tachikoma writes; daemon reads at finalize and posts.
- `/work/.major/<role>.<runId>.transcript.txt` — full subprocess transcript; attached as a `log_artifact_ref`.

## Claude Code CLI shape (assumed)

```
claude --dangerously-skip-permissions --max-turns N --print "<prompt>"
```

- `--dangerously-skip-permissions` — the container is the trust boundary; we don't want interactive permission prompts.
- `--max-turns N` — hard cap on tool-call iterations. Defaults per role in `tachikoma.ts`.
- `--print` — non-interactive; writes the final message to stdout, then exits.

If the CLI's flag names change in a future release, update the `spawn(...)` call in `tachikoma.ts` (the `runSandboxAgent` function) and re-build the image. There is no flag-discovery layer.

## Major API endpoints called

These payload shapes are what `runner/` assumes; they will be checked against `functions/` in the integration phase.

### `POST /major-heartbeat`

Request:
```json
{
  "runnerId": "runner-A",
  "activeRunId": 42 | null,
  "metadata": { "imageTag": "...", "host": "...", "initial": true }
}
```
Response: `{ ok: true }` (no payload required).

### `POST /major-claim-item`

Request:
```json
{
  "runnerId": "runner-A",
  "capabilities": { "supportedArtifactTypes": ["git-change", "triage-change-set"] }
}
```
Response when claim succeeds:
```json
{
  "claimed": true,
  "workItem": {
    "id": 7,
    "title": "...",
    "status": "agent-running",
    "classifications": ["bug-fix"],
    "expectedArtifactType": "git-change",
    "expectedPaths": ["src/services/meals/**"],
    "baseBranch": "develop",
    "gitRepositoryRef": "MioMarker/healthbite",
    "contentMd": "...",
    "currentRevisionId": 19
  },
  "run": {
    "id": 101,
    "purpose": "execute",
    "leaseExpiresAt": "2026-05-09T01:23:45Z",
    "sandboxRef": null
  }
}
```
Response when no work: `{ "claimed": false }`.

### `POST /major-finalize-run`

Request:
```json
{
  "runnerId": "runner-A",
  "runId": 101,
  "workItemId": 7,
  "outcome": "succeeded" | "failed" | "cancelled",
  "cancellationReason": "system-cancellation" | "lease-expired" | "human-cancellation" | "repair-acquisition" | null,
  "nextWorkItemStatus": "ready-for-review" | "ready-for-agent" | "ready-for-human",
  "verifications": [
    {
      "checkName": "tachikoma-implementer",
      "outcome": "pass",
      "required": true,
      "requirednessSource": "artifact-type-policy",
      "payload": { "promptVersion": "implementer@2026-05-09", "durationMs": 12345 }
    }
  ],
  "artifacts": [
    {
      "artifactType": "git-change",
      "externalRef": "https://github.com/.../pull/123",
      "payload": { "prNumber": 123, "headSha": "abc", "commits": ["abc"], "filesTouched": ["src/foo.ts"] }
    }
  ],
  "telemetry": [],
  "summary": "implementer ok, PR https://..., reviewer pass",
  "idempotencyKey": "runner:runner-A:run-finalize:101:succeeded"
}
```
Response: `{ ok: true }`.

## Troubleshooting

### Container exits with code 2 immediately

Missing required env. Check the boot log: it lists missing vars by name.

### Container runs but never claims

Check three things in order:
1. `MAJOR_API_BASE_URL` reachable from inside the container? (`docker exec runner-A curl -i $MAJOR_API_BASE_URL/major-heartbeat`)
2. `SUPABASE_AUTH_TOKEN` valid? (Major API returns 401 → bad token.)
3. Is anything in `ready-for-agent`? Major UI Items View, filter by status. If queue is empty, the runner correctly idles.

### Tachikoma subprocess hangs

The wall-clock cap (`DEFAULT_TIMEOUT_MS_BY_ROLE` in `tachikoma.ts`) kills it after 30 min for implementer / 10 min for reviewer. If you hit this regularly, lower `--max-turns` or split the Item.

### Heartbeat lapse → Item reaped

Major's `major-reaper` cron marks claims expired after `lease_expires_at`. If your runner is alive but heartbeats are timing out (e.g. slow Supabase region), the runner detects this on the next API call (lease ownership check fails) and aborts the Run gracefully — the next claim wins. Check `runner_instances.heartbeat_at` vs system time; large skew → fix container clock or network.

### `gh pr create` fails inside the sandbox

`GITHUB_TOKEN` permissions. Token needs `repo`, `pull_requests:write`, `statuses:write`. The Tachikoma's stdout will include the `gh` error message — it's in `/work/.major/<role>.<runId>.transcript.txt`.

### Sandbox cleanup failed

Runs are independent — a failed cleanup of `/work/<repo>/` for Run N doesn't affect Run N+1, because `prepareSandbox` always `rm -rf`s before cloning. But the disk fills up over time; rotate the container if you see space pressure.

## Local development

The runner is hard to run outside a container (it needs `gh`, Claude Code CLI, Deno, Node 20). For unit-level work on `tachikoma.ts` / `main.ts`:

```sh
cd ~/Projects/major/runner
npm install
npm run typecheck   # `tsc --noEmit`
npm run build       # `tsc` → dist/
```

You can mock the Claude Code subprocess by setting the `claude` shell command to a stub that emits canned JSON; that's enough to exercise the parsing path.
