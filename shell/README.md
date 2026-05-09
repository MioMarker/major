# Major Shell

Long-lived Docker container that polls Major for `ready-for-agent` Briefs, claims one at a time, and runs Tachikoma (Claude Code) phases against a sandboxed clone of the target repository.

One container = one Shell. To scale parallelism, run N containers with distinct `SHELL_ID` values.

See `~/Projects/major/SPEC.md` §Shell architecture for the conceptual model.

## Build

```sh
cd ~/Projects/major/shell
docker build -t major-shell .
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
  --name shell-A \
  --restart unless-stopped \
  -e SHELL_ID=shell-A \
  -e MAJOR_API_BASE_URL="https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1" \
  -e SUPABASE_SERVICE_ROLE_KEY="<service-role-key from Supabase dashboard>" \
  -e GITHUB_TOKEN="<gh PAT or installation token with PR + commit + status:write>" \
  -e CLAUDE_CODE_OAUTH_TOKEN="<from `claude setup-token` — Max subscription>" \
  major-shell
# Alternative: -e ANTHROPIC_API_KEY="<sk-ant-...>" if you don't have a Max plan
```

Multiple Shells — run side-by-side with different `SHELL_ID`s:

```sh
docker run -d --name shell-A -e SHELL_ID=shell-A ... major-shell
docker run -d --name shell-B -e SHELL_ID=shell-B ... major-shell
```

The atomic claim path (`major-claim-brief`) handles the race; only one Shell wins each Brief.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `SHELL_ID` | yes | Unique id for this container; used as the row id in the Shell table (`major.shells`). Must be stable across restarts of the same container. |
| `MAJOR_API_BASE_URL` | yes | Supabase functions root (no trailing slash). E.g. `https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1`. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Sent as Bearer to Major's API alongside the `X-Major-Shell-Id` header. The auth helper recognizes the service-role bypass and attributes calls to `shell:<SHELL_ID>`. From Supabase dashboard → Project Settings → API → service_role secret. |
| `GITHUB_TOKEN` | yes | For `gh` auth inside the sandbox (PR create, status checks, CI poll). Needs `repo`, `pull_requests:write`, `statuses:write`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of two | Max subscription token. Generate via `claude setup-token`. Preferred over the API key when you have a Max plan — same convention as Sandcastle. |
| `ANTHROPIC_API_KEY` | one of two | API key fallback. Set this *or* `CLAUDE_CODE_OAUTH_TOKEN` (the Shell exits if both are empty). |
| `IMAGE_TAG` | no | Recorded in the Shell row's `metadata.imageTag` for provenance. |

## What happens on boot

1. `main.ts` reads env, exits with code 2 if anything is missing.
2. Calls `POST major-heartbeat` once with `initial: true` — this is where the Shell row is upserted into the Shell table.
3. Spawns a 30s heartbeat thread (renews `heartbeat_at` and, if a Run is active, the Run's lease).
4. Enters the main loop:
   - `POST major-claim-brief`. If no work, sleep 10s, repeat.
   - On claim: `git clone` the target repo to `/work/<repo-name>/`, checkout `major/brief-<id>`.
   - **Phase 1** — implementer Tachikoma (`runSandboxAgent({ role: "implementer", ...})`).
   - Wait for CI on the resulting PR (poll `gh pr checks` every 30s, timeout 20 min).
   - **Phase 2** — reviewer Tachikoma (only if implementer succeeded with a PR).
   - `POST major-finalize-run` with verifications + artifacts + telemetry + outcome + next Brief status.
   - Wipe `/work/<repo-name>/`, loop.

## Sandbox isolation strategy

**Each Brief gets a fresh `/work/<repo-name>/`**, cloned at claim time and removed at finalize time. The container's filesystem is the only sandbox boundary; we don't run Briefs in nested containers.

`/work/.major/` is the per-Run scratch directory, used by the daemon to drop files the Tachikoma reads:

- `/work/.major/brief.json` — Brief snapshot.
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

These payload shapes are what `shell/` assumes; they will be checked against `functions/` in the integration phase.

### `POST /major-heartbeat`

Request:
```json
{
  "shellId": "shell-A",
  "activeRunId": 42 | null,
  "metadata": { "imageTag": "...", "host": "...", "initial": true }
}
```
Response: `{ ok: true }` (no payload required).

### `POST /major-claim-brief`

Request:
```json
{
  "shellId": "shell-A",
  "capabilities": { "supportedArtifactTypes": ["git-change", "triage-change-set"] }
}
```
Response when claim succeeds:
```json
{
  "claimed": true,
  "brief": {
    "id": 7,
    "title": "...",
    "status": "agent-running",
    "classifications": ["bug-fix"],
    "expectedArtifactType": "git-change",
    "expectedPaths": ["src/services/meals/**"],
    "baseBranch": "dev",
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
  "shellId": "shell-A",
  "runId": 101,
  "briefId": 7,
  "outcome": "succeeded" | "failed" | "cancelled",
  "cancellationReason": "system-cancellation" | "lease-expired" | "human-cancellation" | "repair-acquisition" | null,
  "nextBriefStatus": "ready-for-review" | "ready-for-agent" | "ready-for-human",
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
  "idempotencyKey": "shell:shell-A:run-finalize:101:succeeded"
}
```
Response: `{ ok: true }`.

## Troubleshooting

### Container exits with code 2 immediately

Missing required env. Check the boot log: it lists missing vars by name.

### Container runs but never claims

Check three things in order:
1. `MAJOR_API_BASE_URL` reachable from inside the container? (`docker exec shell-A curl -i $MAJOR_API_BASE_URL/major-heartbeat`)
2. `SUPABASE_AUTH_TOKEN` valid? (Major API returns 401 → bad token.)
3. Is anything in `ready-for-agent`? Major UI Briefs View, filter by status. If queue is empty, the Shell correctly idles.

### Tachikoma subprocess hangs

The wall-clock cap (`DEFAULT_TIMEOUT_MS_BY_ROLE` in `tachikoma.ts`) kills it after 30 min for implementer / 10 min for reviewer. If you hit this regularly, lower `--max-turns` or split the Brief.

### Heartbeat lapse → Brief reaped

Major's `major-reaper` cron marks claims expired after `lease_expires_at`. If your Shell is alive but heartbeats are timing out (e.g. slow Supabase region), the Shell detects this on the next API call (lease ownership check fails) and aborts the Run gracefully — the next claim wins. Check the Shell row's `heartbeat_at` vs system time; large skew → fix container clock or network.

### `gh pr create` fails inside the sandbox

`GITHUB_TOKEN` permissions. Token needs `repo`, `pull_requests:write`, `statuses:write`. The Tachikoma's stdout will include the `gh` error message — it's in `/work/.major/<role>.<runId>.transcript.txt`.

### Sandbox cleanup failed

Runs are independent — a failed cleanup of `/work/<repo>/` for Run N doesn't affect Run N+1, because `prepareSandbox` always `rm -rf`s before cloning. But the disk fills up over time; rotate the container if you see space pressure.

## Local development

The Shell is hard to run outside a container (it needs `gh`, Claude Code CLI, Deno, Node 20). For unit-level work on `tachikoma.ts` / `main.ts`:

```sh
cd ~/Projects/major/shell
npm install
npm run typecheck   # `tsc --noEmit`
npm run build       # `tsc` → dist/
```

You can mock the Claude Code subprocess by setting the `claude` shell command to a stub that emits canned JSON; that's enough to exercise the parsing path.
