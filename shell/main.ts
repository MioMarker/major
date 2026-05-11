// shell/main.ts — Major Shell daemon entry point.
//
// One container = one Shell. This process:
//   1. Boots: validate env, register itself in major.shells via
//      heartbeat, start a 30s heartbeat thread.
//   2. Loops: poll major-claim-brief; on claim, run implementer + (gated)
//      reviewer Tachikoma phases inside one shared sandbox checkout.
//   3. Finalizes: record verifications + artifacts + outcome via
//      major-finalize-run, then clean up the sandbox and loop.
//   4. Shuts down gracefully on SIGTERM: cancels the in-flight Run as
//      System Run Cancellation so the orchestrator routes the Brief correctly.
//
// API endpoints called (caller / payload assumptions):
//   POST {MAJOR_API_BASE_URL}/major-heartbeat
//        → register/refresh shell row + (if owned) renew lease
//   POST {MAJOR_API_BASE_URL}/major-claim-brief
//        → atomic Run Start Transaction; returns claim ticket
//   POST {MAJOR_API_BASE_URL}/major-finalize-run
//        → Run Finalization Transaction; one call per Run
//   GET  {MAJOR_API_BASE_URL}/major-list-briefs?status=ready-for-agent
//        → unused in v1 (claim is server-side queue-pop); kept for future
//
// All endpoints share `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`
// + `X-Major-Shell-Id: <SHELL_ID>`. The auth helper recognizes the
// service-role bypass and attributes actions to shell:<SHELL_ID>.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runSandboxAgent, type TachikomaBriefSnapshot, type TachikomaRunSnapshot, type ParsedEvent } from "./tachikoma";
import { parsePlannerOutput, shouldRunPlanner } from "./planner-helpers";

// ────────────────────────────────────────────────────────────────────
// Env + constants
// ────────────────────────────────────────────────────────────────────

interface ShellEnv {
  apiBaseUrl: string;
  shellId: string;
  githubToken: string;
  supabaseServiceRoleKey: string;
  /** Max-subscription OAuth token (preferred). Mutually optional with anthropicApiKey. */
  claudeCodeOauthToken: string;
  /** API key fallback. Mutually optional with claudeCodeOauthToken. */
  anthropicApiKey: string;
}

function readEnv(): ShellEnv {
  const apiBaseUrl = (process.env.MAJOR_API_BASE_URL ?? "").trim();
  const shellId = (process.env.SHELL_ID ?? "").trim();
  const githubToken = (process.env.GITHUB_TOKEN ?? "").trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const claudeCodeOauthToken = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  const anthropicApiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();

  const missing: string[] = [];
  if (!apiBaseUrl) missing.push("MAJOR_API_BASE_URL");
  if (!shellId) missing.push("SHELL_ID");
  if (!githubToken) missing.push("GITHUB_TOKEN");
  if (!supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  // Claude auth: at least one of CLAUDE_CODE_OAUTH_TOKEN (Max) or
  // ANTHROPIC_API_KEY (API). Mirrors Sandcastle's `_shared/env.mts`.
  if (!claudeCodeOauthToken && !anthropicApiKey) {
    missing.push("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
  }

  if (missing.length > 0) {
    log("error", "missing required env", { missing });
    process.exit(2);
  }

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    shellId,
    githubToken,
    supabaseServiceRoleKey,
    claudeCodeOauthToken,
    anthropicApiKey,
  };
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_IDLE_MS = 10_000;
const TRIAGE_POLL_IDLE_MS = 15_000;
const CI_POLL_INTERVAL_MS = 30_000;
const CI_POLL_TIMEOUT_MS = 20 * 60_000; // 20 min per SPEC

// HTTP retry policy for Major API calls. Exponential backoff with jitter.
const MAX_HTTP_RETRIES = 5;
const HTTP_BACKOFF_BASE_MS = 1000;

// ────────────────────────────────────────────────────────────────────
// Module state
// ────────────────────────────────────────────────────────────────────

interface ActiveRunState {
  runId: number;
  briefId: number;
  leaseExpiresAt: string;
  /** Per-Run sandbox dir, e.g. /work/healthbite. */
  sandboxDir: string;
  /** Implementer's parsed JSON output, set after Phase 1 succeeds. */
  implementerOutput: ImplementerOutput | null;
}

let activeRun: ActiveRunState | null = null;
let shuttingDown = false;
let env: ShellEnv;

// ────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  env = readEnv();

  log("info", "shell booting", {
    shellId: env.shellId,
    apiBaseUrl: env.apiBaseUrl,
  });

  // Hand off the GitHub token to the `gh` CLI in a way the subprocess sees it.
  // gh auto-reads $GH_TOKEN; export both forms for safety.
  process.env.GH_TOKEN = env.githubToken;
  process.env.GITHUB_TOKEN = env.githubToken;

  // Initial registration — INSERT INTO major.shells ON CONFLICT UPDATE.
  await callHeartbeat({ initial: true });

  // Heartbeat thread: every 30s, refresh the Shell row's heartbeat_at and
  // (if a Run is active) renew the Run's lease via the same call.
  const hbHandle = setInterval(() => {
    void callHeartbeat({ initial: false }).catch((err) => {
      log("warn", "heartbeat failed (will retry next tick)", { error: errToString(err) });
    });
  }, HEARTBEAT_INTERVAL_MS);
  hbHandle.unref();

  // Graceful shutdown handlers.
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutdown signal received", { signal });
    void gracefulShutdown().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Main loop + triage session loop run concurrently.
  await Promise.all([mainLoop(), triageSessionLoop()]);
}

// ────────────────────────────────────────────────────────────────────
// Main loop
// ────────────────────────────────────────────────────────────────────

async function mainLoop(): Promise<void> {
  while (!shuttingDown) {
    let claim: ClaimResponse | null = null;
    try {
      claim = await callClaimItem();
    } catch (err) {
      log("warn", "claim attempt failed", { error: errToString(err) });
      await sleep(POLL_IDLE_MS);
      continue;
    }

    if (!claim || !claim.claimed) {
      // No work available. Idle and re-poll.
      await sleep(POLL_IDLE_MS);
      continue;
    }

    log("info", "claimed brief", {
      briefId: claim.brief.id,
      runId: claim.run.id,
      leaseExpiresAt: claim.run.leaseExpiresAt,
    });

    activeRun = {
      runId: claim.run.id,
      briefId: claim.brief.id,
      leaseExpiresAt: claim.run.leaseExpiresAt,
      sandboxDir: "",
      implementerOutput: null,
    };

    try {
      await executeRun(claim);
    } catch (err) {
      log("error", "run execution threw", {
        runId: claim.run.id,
        error: errToString(err),
      });
      // Best-effort: finalize as failed. If finalization itself blew up, the
      // Reaper will handle it via heartbeat lapse.
      try {
        await callFinalizeRun({
          runId: claim.run.id,
          briefId: claim.brief.id,
          outcome: "failed",
          cancellationReason: null,
          // Park the brief for human review on Shell-side exceptions.
          // Returning to ready-for-agent immediately re-arms the brief and
          // produces a tight reclaim loop on persistent setup failures
          // (e.g. git checkout missing a base ref). A human should inspect
          // before any retry; auto-retry with budget can ship later.
          nextBriefStatus: "ready-for-human",
          verifications: [],
          artifacts: [],
          telemetry: [
            {
              observationType: "external-system-error",
              payload: {
                stage: "execute-run",
                error: errToString(err),
              },
            },
          ],
          summary: "shell threw during run execution",
        });
      } catch (finalizeErr) {
        log("error", "finalize after exception ALSO failed; reaper will handle", {
          runId: claim.run.id,
          error: errToString(finalizeErr),
        });
      }
    } finally {
      const sb = activeRun?.sandboxDir;
      activeRun = null;
      if (sb) await cleanupSandbox(sb);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Triage session loop — auto-triages GitHub-seeded sessions
// ────────────────────────────────────────────────────────────────────

interface TriageSessionRow {
  id: number;
  trigger_payload: {
    source_issue_title?: string;
    source_issue_body_md?: string;
    source_issue_repo?: string;
    source_issue_number?: number;
  };
}

interface TriageOutput {
  phase: "triage";
  ok: boolean;
  summary: string;
  operations: Array<Record<string, unknown>>;
}

function parseTriageOutput(raw: unknown): TriageOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.phase !== "triage") return null;
  if (typeof obj.ok !== "boolean") return null;
  if (typeof obj.summary !== "string") return null;
  if (!Array.isArray(obj.operations)) return null;
  return obj as unknown as TriageOutput;
}

async function triageSessionLoop(): Promise<void> {
  while (!shuttingDown) {
    let session: TriageSessionRow | null = null;
    try {
      session = await callPollAndClaimTriageSession();
    } catch (err) {
      log("warn", "triage session poll/claim failed", { error: errToString(err) });
      await sleep(TRIAGE_POLL_IDLE_MS);
      continue;
    }

    if (!session) {
      await sleep(TRIAGE_POLL_IDLE_MS);
      continue;
    }

    log("info", "claimed triage session", { sessionId: session.id });
    try {
      await runTriageSession(session);
    } catch (err) {
      log("error", "triage session threw", {
        sessionId: session.id,
        error: errToString(err),
      });
      await callReleaseTriageSession(session.id).catch((releaseErr) => {
        log("warn", "release triage session failed", {
          sessionId: session.id,
          error: errToString(releaseErr),
        });
      });
    }
  }
}

async function runTriageSession(session: TriageSessionRow): Promise<void> {
  const triageDir = path.join("/work", `.triage-${session.id}`);
  await fs.mkdir(triageDir, { recursive: true });
  try {
    const tp = session.trigger_payload;

    // Encode session context in contentMd as a frontmatter block so the
    // Tachikoma receives it without requiring tachikoma.ts changes.
    const frontmatter = [
      "---",
      `triage_mode: session`,
      `source_issue_number: ${tp.source_issue_number ?? ""}`,
      `source_session_id: ${session.id}`,
      "---",
      "",
    ].join("\n");
    const contentMd = frontmatter + (tp.source_issue_body_md ?? "");

    const brief: TachikomaBriefSnapshot = {
      id: session.id,
      title: tp.source_issue_title ?? `Session #${session.id}`,
      status: "open",
      classifications: [],
      expectedArtifactType: null,
      expectedPaths: [],
      baseBranch: "dev",
      gitRepositoryRef: tp.source_issue_repo ?? null,
      contentMd,
      currentRevisionId: null,
    };

    const runMeta: TachikomaRunSnapshot = {
      id: session.id,
      purpose: "triage",
      shellId: env.shellId,
    };

    // Write stub context files that the triage prompt reads.
    const majorDir = path.join("/work", ".major");
    await fs.mkdir(majorDir, { recursive: true });
    await fs.writeFile(
      path.join(majorDir, "queue.json"),
      JSON.stringify({ briefs: [] }, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(majorDir, "path_blocker_config.json"),
      JSON.stringify({ protected_globs: [], mass_rerank_threshold: 10 }, null, 2),
      "utf8",
    );

    const result = await runSandboxAgent({
      role: "triage",
      sandboxDir: triageDir,
      brief,
      run: runMeta,
    });

    log("info", "triage Tachikoma ended", {
      sessionId: session.id,
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });

    if (!result.ok) {
      log("warn", "triage Tachikoma failed; releasing session", { sessionId: session.id });
      await callReleaseTriageSession(session.id);
      return;
    }

    const triageOutput = parseTriageOutput(result.parsedOutput);
    if (!triageOutput || !triageOutput.ok || triageOutput.operations.length === 0) {
      log("warn", "triage output invalid or empty; releasing session", { sessionId: session.id });
      await callReleaseTriageSession(session.id);
      return;
    }

    await callFinalizeTriageSession({
      sessionId: session.id,
      summary: triageOutput.summary,
      operations: triageOutput.operations,
    });

    log("info", "triage session finalized", { sessionId: session.id });
  } finally {
    await fs.rm(triageDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────
// Triage session API helpers (PostgREST direct — no edge function for
// poll/claim/release; finalize uses the existing major-finalize-triage-session)
// ────────────────────────────────────────────────────────────────────

function supabaseRestBase(): string {
  return env.apiBaseUrl.replace("/functions/v1", "/rest/v1");
}

async function callPollAndClaimTriageSession(): Promise<TriageSessionRow | null> {
  const restBase = supabaseRestBase();

  const listResp = await fetch(
    `${restBase}/triage_sessions?entry_point=eq.integration%3Agithub&status=eq.open&auto_triage_shell_id=is.null&select=id,trigger_payload`,
    {
      headers: {
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        apikey: env.supabaseServiceRoleKey,
        Accept: "application/json",
      },
    },
  );
  if (!listResp.ok) {
    throw new Error(`poll triage sessions HTTP ${listResp.status}`);
  }
  const sessions = (await listResp.json()) as TriageSessionRow[];
  const eligible = sessions.filter(
    (s) =>
      typeof s.trigger_payload?.source_issue_body_md === "string" &&
      s.trigger_payload.source_issue_body_md.length > 0,
  );
  if (eligible.length === 0) return null;

  // Atomic optimistic claim: PATCH with WHERE auto_triage_shell_id IS NULL guard.
  const candidate = eligible[0];
  const claimResp = await fetch(
    `${restBase}/triage_sessions?id=eq.${candidate.id}&auto_triage_shell_id=is.null`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
        apikey: env.supabaseServiceRoleKey,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        auto_triage_shell_id: env.shellId,
        auto_triage_started_at: new Date().toISOString(),
      }),
    },
  );
  if (!claimResp.ok) {
    throw new Error(`claim triage session HTTP ${claimResp.status}`);
  }
  const claimed = (await claimResp.json()) as TriageSessionRow[];
  // 0 rows = race lost; another Shell claimed it first.
  if (claimed.length === 0) return null;
  return candidate;
}

async function callReleaseTriageSession(sessionId: number): Promise<void> {
  const restBase = supabaseRestBase();
  await fetch(`${restBase}/triage_sessions?id=eq.${sessionId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      apikey: env.supabaseServiceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auto_triage_shell_id: null,
      auto_triage_started_at: null,
    }),
  });
}

async function callFinalizeTriageSession(args: {
  sessionId: number;
  summary: string;
  operations: Array<Record<string, unknown>>;
}): Promise<void> {
  await majorApiPost("major-finalize-triage-session", {
    sessionId: args.sessionId,
    summary: args.summary,
    operations: args.operations,
  });
}

// ────────────────────────────────────────────────────────────────────
// Run execution: implementer (Phase 1) → CI poll → reviewer (Phase 2)
// ────────────────────────────────────────────────────────────────────

async function executeRun(claim: ClaimResponse): Promise<void> {
  if (!activeRun) throw new Error("invariant: executeRun called without activeRun");

  // 1. Prepare sandbox: clone repo, checkout branch.
  const sandboxDir = await prepareSandbox(claim);
  activeRun.sandboxDir = sandboxDir;

  // /work/.major/ is not (yet) cleaned between Briefs (F-15 — see
  // docs/plans/001-e2e-reliability-fixes.md). Until that lands, defensively
  // remove any stale plan.md so a Brief whose Planner gate doesn't match
  // can't pick up a previous Brief's plan as its own.
  await fs.rm(path.join("/work", ".major", "plan.md"), { force: true });

  const brief: TachikomaBriefSnapshot = {
    id: claim.brief.id,
    title: claim.brief.title,
    status: claim.brief.status,
    classifications: claim.brief.classifications,
    expectedArtifactType: claim.brief.expectedArtifactType,
    expectedPaths: claim.brief.expectedPaths,
    baseBranch: claim.brief.baseBranch,
    gitRepositoryRef: claim.brief.gitRepositoryRef,
    contentMd: claim.brief.contentMd,
    currentRevisionId: claim.brief.currentRevisionId,
  };

  const runMeta: TachikomaRunSnapshot = {
    id: claim.run.id,
    purpose: "execute",
    shellId: env.shellId,
  };

  // Per-Run stream-event sequence counter. Shared across all phases so
  // idempotency keys are globally unique within a Run. Incremented before
  // each POST, so starts at 0 and the first event gets sequence=1.
  let streamSeq = 0;
  let totalParseErrors = 0;

  const onStreamEvent = async (event: ParsedEvent): Promise<void> => {
    streamSeq++;
    const key = `${claim.run.id}:tachikoma-stream-event:${env.shellId}:${streamSeq}`;
    try {
      await callRecordTelemetry({
        runId: claim.run.id,
        observationType: "tachikoma-stream-event",
        payload: {
          eventKind: event.eventKind,
          body: event.body,
          shell_id: env.shellId,
          sequence: streamSeq,
        },
        idempotencyKey: key,
      });
    } catch (err) {
      log("warn", "stream-event telemetry write failed (continuing)", {
        runId: claim.run.id,
        sequence: streamSeq,
        error: errToString(err),
      });
    }
  };

  // Result accumulators. All phases push to these.
  const verifications: VerificationPayload[] = [];
  const artifacts: ArtifactPayload[] = [];

  // 1.5. Phase 0 (gated): planner. Per ADR 013 / Phase 1 Decision 1, runs only
  //      when the Brief benefits from explicit decomposition — multi-path or
  //      epic/parent classification. Plan is Markdown at /work/.major/plan.md;
  //      Implementer reads it as context. Verification is advisory per
  //      Phase 1 Decision 3 — a failed planner subprocess does not park the
  //      Brief; Implementer still runs.
  if (shouldRunPlanner(brief)) {
    log("info", "phase: planner starting", { runId: claim.run.id });
    const planner = await runSandboxAgent({
      role: "planner",
      sandboxDir,
      brief,
      run: runMeta,
      onStreamEvent,
    });
    log("info", "phase: planner ended", {
      runId: claim.run.id,
      ok: planner.ok,
      exitCode: planner.exitCode,
      durationMs: planner.durationMs,
      parseErrors: planner.tachikomaParseErrors,
    });
    totalParseErrors += planner.tachikomaParseErrors;

    const plannerOutput = parsePlannerOutput(planner.parsedOutput);
    verifications.push({
      check_name: "tachikoma-planner",
      outcome: planner.ok ? "pass" : "fail",
      required: false, // advisory per ADR 013 / Phase 1 Decision 3
      requiredness_source: "artifact-type-policy",
      payload: {
        promptVersion: planner.promptVersion,
        durationMs: planner.durationMs,
        exitCode: planner.exitCode,
        transcriptRef: planner.transcriptPath,
        outputSnippet: planner.stdoutSnippet.slice(-1024),
        scopeCheck: plannerOutput?.scope_check ?? null,
        filesPlanned: plannerOutput?.files_planned ?? null,
        additionalPathsNeeded: plannerOutput?.additional_paths_needed ?? null,
      },
    });

    // A *successful* Planner reporting expansion-needed is authoritative —
    // skip Implementer + Reviewer and route to ready-for-human so a human can
    // re-Triage. (Distinct from the advisory "planner subprocess failed"
    // case, which falls through to Implementer per Decision 3.)
    if (planner.ok && plannerOutput?.scope_check === "expansion-needed") {
      const earlyTelemetry: TelemetryPayload[] = await readTelemetryJsonl();
      if (totalParseErrors > 0) {
        earlyTelemetry.push({
          observationType: "tachikoma-stream-parse-errors",
          payload: { count: totalParseErrors, runId: claim.run.id },
        });
      }
      await callFinalizeRun({
        runId: claim.run.id,
        briefId: claim.brief.id,
        outcome: "failed",
        cancellationReason: null,
        nextBriefStatus: "ready-for-human",
        verifications,
        artifacts: [],
        telemetry: earlyTelemetry,
        summary: "planner reported expected-paths-insufficient",
        tachikomaCompletion: planner.completionEvent?.body,
      });
      log("info", "run finalized", {
        runId: claim.run.id,
        outcome: "failed",
        nextStatus: "ready-for-human",
      });
      return;
    }
  }

  // 2. Phase 1: implementer.
  log("info", "phase: implementer starting", { runId: claim.run.id });
  const implementer = await runSandboxAgent({
    role: "implementer",
    sandboxDir,
    brief,
    run: runMeta,
    onStreamEvent,
  });
  log("info", "phase: implementer ended", {
    runId: claim.run.id,
    ok: implementer.ok,
    exitCode: implementer.exitCode,
    durationMs: implementer.durationMs,
    parseErrors: implementer.tachikomaParseErrors,
  });
  totalParseErrors += implementer.tachikomaParseErrors;

  const implementerOutput = parseImplementerOutput(implementer.parsedOutput);
  activeRun.implementerOutput = implementerOutput;

  // Write implementer output to disk so Phase 2 reviewer can read it.
  await fs.writeFile(
    path.join("/work", ".major", "implementer-output.json"),
    JSON.stringify(implementerOutput ?? { ok: false }, null, 2),
    "utf8",
  );

  const telemetry: TelemetryPayload[] = await readTelemetryJsonl();
  if (totalParseErrors > 0) {
    telemetry.push({
      observationType: "tachikoma-stream-parse-errors",
      payload: { count: totalParseErrors, runId: claim.run.id },
    });
  }

  // Verifications: copy implementer's reported checks, plus a meta-check for
  // the Tachikoma subprocess itself.
  verifications.push({
    check_name: "tachikoma-implementer",
    outcome: implementer.ok ? "pass" : "fail",
    required: true,
    requiredness_source: "artifact-type-policy",
    payload: {
      promptVersion: implementer.promptVersion,
      durationMs: implementer.durationMs,
      exitCode: implementer.exitCode,
      transcriptRef: implementer.transcriptPath,
      outputSnippet: implementer.stdoutSnippet.slice(-1024),
    },
  });
  if (implementerOutput?.verifications) {
    for (const v of implementerOutput.verifications) {
      // Normalize first; the implementer can report variants like "n/a" or
      // "not-applicable" that should fold into "skipped". Then derive
      // requiredness from the normalized outcome — checking raw v.outcome
      // misses non-canonical skip variants and keeps required=true on them,
      // which fails the run for the same reason issue #40 originally did.
      const normalizedOutcome: "pass" | "fail" | "skipped" =
        v.outcome === "pass" ? "pass" : v.outcome === "fail" ? "fail" : "skipped";
      verifications.push({
        check_name: v.check,
        outcome: normalizedOutcome,
        // Skipped checks are advisory: the implementer self-reports `skipped`
        // only when a check is inapplicable to the diff (e.g. tsc-noemit on a
        // doc-only diff). Pass/fail outcomes stay required per artifact-type-policy.
        required: normalizedOutcome !== "skipped",
        requiredness_source: "artifact-type-policy",
        payload: { durationMs: v.duration_ms ?? null },
      });
    }
  }

  // 3. If implementer produced a PR, capture it as an artifact and poll CI.
  if (implementer.ok && implementerOutput?.pr_url && implementerOutput.pr_number) {
    artifacts.push({
      artifact_type: "git-change",
      external_ref: implementerOutput.pr_url,
      payload: {
        prNumber: implementerOutput.pr_number,
        headSha: implementerOutput.head_sha ?? null,
        commits: implementerOutput.commits ?? [],
        filesTouched: implementerOutput.files_touched ?? [],
      },
    });

    const ciResult = await waitForCI({
      sandboxDir,
      prNumber: implementerOutput.pr_number,
      gitRepositoryRef: claim.brief.gitRepositoryRef ?? "",
    });
    verifications.push({
      check_name: "ci-rollup",
      outcome: ciResult.outcome,
      required: ciResult.outcome !== "skipped", // advisory if no CI configured
      requiredness_source: "artifact-type-policy",
      payload: {
        durationMs: ciResult.durationMs,
        outputSnippet: ciResult.summary,
      },
    });
    log("info", "ci wait ended", {
      runId: claim.run.id,
      outcome: ciResult.outcome,
      durationMs: ciResult.durationMs,
    });
  }

  // 4. Phase 2: reviewer (only if implementer succeeded with a PR).
  let reviewerOk = false;
  let reviewerStatus: "pass" | "fail" | "pending" | null = null;
  if (implementer.ok && implementerOutput?.pr_url && implementerOutput.pr_number) {
    log("info", "phase: reviewer starting", { runId: claim.run.id });
    const reviewer = await runSandboxAgent({
      role: "reviewer",
      sandboxDir,
      brief,
      run: runMeta,
      onStreamEvent,
    });
    log("info", "phase: reviewer ended", {
      runId: claim.run.id,
      ok: reviewer.ok,
      exitCode: reviewer.exitCode,
      durationMs: reviewer.durationMs,
      parseErrors: reviewer.tachikomaParseErrors,
    });
    totalParseErrors += reviewer.tachikomaParseErrors;

    reviewerOk = reviewer.ok;
    const reviewerOutput = parseReviewerOutput(reviewer.parsedOutput);
    if (reviewerOutput) reviewerStatus = reviewerOutput.status;

    verifications.push({
      check_name: "tachikoma-reviewer",
      outcome: reviewer.ok ? "pass" : "fail",
      required: false, // reviewer is advisory per SPEC §Authority
      requiredness_source: "artifact-type-policy",
      payload: {
        promptVersion: reviewer.promptVersion,
        durationMs: reviewer.durationMs,
        exitCode: reviewer.exitCode,
        transcriptRef: reviewer.transcriptPath,
        outputSnippet: reviewer.stdoutSnippet.slice(-1024),
        status: reviewerStatus,
      },
    });
  }

  // 5. Finalize.
  const allRequiredPassed = verifications
    .filter((v) => v.required)
    .every((v) => v.outcome === "pass");

  let outcome: "succeeded" | "failed";
  let nextStatus: string;
  let cancellationReason: string | null = null;
  let summary: string;

  if (implementer.ok && implementerOutput?.pr_url && allRequiredPassed) {
    outcome = "succeeded";
    nextStatus = "ready-for-review";
    summary = `implementer ok, PR ${implementerOutput.pr_url}, reviewer ${reviewerStatus ?? "n/a"}`;
  } else if (implementer.ok && !allRequiredPassed) {
    // PR exists but a required check failed. Park for human review per ADR 012;
    // re-arming ready-for-agent here produced the same tight reclaim loop that
    // bit the exception path before issue #17 (~2 runs/sec). Budgeted retry is
    // explicitly deferred to a future ADR with concrete trigger criteria.
    outcome = "failed";
    nextStatus = "ready-for-human";
    summary = "required verification failed; parked for human review";
  } else if (!implementer.ok && implementerOutputBailReason(implementerOutput) === "expected-paths-insufficient") {
    // Scope bail: not retry-safe; route to human.
    outcome = "failed";
    nextStatus = "ready-for-human";
    summary = "implementer reported expected-paths-insufficient";
  } else {
    // Generic implementer failure. Park for human review per ADR 012 — the
    // same disposition as the failed-with-PR path above and the executeRun-
    // throws path patched in #17. No retry budget exists yet.
    outcome = "failed";
    nextStatus = "ready-for-human";
    summary = `implementer failed (exit=${implementer.exitCode})`;
  }

  await callFinalizeRun({
    runId: claim.run.id,
    briefId: claim.brief.id,
    outcome,
    cancellationReason,
    nextBriefStatus: nextStatus,
    verifications,
    artifacts,
    telemetry,
    summary,
    tachikomaCompletion: implementer.completionEvent?.body,
  });

  log("info", "run finalized", { runId: claim.run.id, outcome, nextStatus });
}

// ────────────────────────────────────────────────────────────────────
// Sandbox lifecycle
// ────────────────────────────────────────────────────────────────────

/** Each Brief gets a fresh /work/<repo-name>/, wiped at end of Run. */
async function prepareSandbox(claim: ClaimResponse): Promise<string> {
  const repoRef = claim.brief.gitRepositoryRef;
  if (!repoRef) {
    throw new Error("brief has no gitRepositoryRef; cannot prepare sandbox");
  }
  const repoName = repoRef.split("/").pop() ?? "repo";
  const sandboxDir = path.join("/work", repoName);

  // If a previous Run left this dir behind (shouldn't happen — cleanupSandbox
  // runs in finally — but defense-in-depth), nuke it.
  await fs.rm(sandboxDir, { recursive: true, force: true });

  // Clone via HTTPS with the GITHUB_TOKEN; gh-style URL.
  const cloneUrl = `https://x-access-token:${env.githubToken}@github.com/${repoRef}.git`;
  const baseBranch = claim.brief.baseBranch ?? "dev";
  const featureBranch = `major/brief-${claim.brief.id}`;

  await runShellCmd("git", ["clone", "--depth", "50", cloneUrl, sandboxDir]);

  // `git clone --depth N` implicitly enables `--single-branch`, locking the
  // origin remote's fetch refspec to the default branch only. Subsequent
  // `git fetch origin <baseBranch>` then only writes FETCH_HEAD and never
  // populates `refs/remotes/origin/<baseBranch>` — so `checkout -b <feature>
  // origin/<baseBranch>` fails when the brief's baseBranch differs from the
  // repo default. Widening the refspec here makes that fetch behave as
  // expected for any base branch.
  await runShellCmd("git", ["-C", sandboxDir, "remote", "set-branches", "origin", "*"]);

  // Configure committer identity for any commits the Tachikoma makes.
  await runShellCmd("git", ["-C", sandboxDir, "config", "user.name", "Claude Code Tachikoma"]);
  await runShellCmd("git", ["-C", sandboxDir, "config", "user.email", "tachikoma@major.local"]);

  // Fetch the feature branch in case a previous Run pushed commits to it
  // (retry case — same branch reused per SPEC §Failure modes).
  await runShellCmd("git", ["-C", sandboxDir, "fetch", "--depth", "50", "origin", baseBranch]);
  const remoteHasFeature = await branchExistsOnRemote(sandboxDir, featureBranch);
  if (remoteHasFeature) {
    await runShellCmd("git", ["-C", sandboxDir, "fetch", "origin", featureBranch]);
    await runShellCmd("git", ["-C", sandboxDir, "checkout", featureBranch]);
  } else {
    // Brand-new feature branch off baseBranch.
    await runShellCmd("git", ["-C", sandboxDir, "checkout", "-b", featureBranch, `origin/${baseBranch}`]);
  }

  log("info", "sandbox ready", { sandboxDir, baseBranch, featureBranch });
  return sandboxDir;
}

async function branchExistsOnRemote(sandboxDir: string, branch: string): Promise<boolean> {
  try {
    const result = await runShellCmdCapture("git", ["-C", sandboxDir, "ls-remote", "--heads", "origin", branch]);
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function cleanupSandbox(sandboxDir: string): Promise<void> {
  try {
    await fs.rm(sandboxDir, { recursive: true, force: true });
    log("info", "sandbox cleaned up", { sandboxDir });
  } catch (err) {
    log("warn", "sandbox cleanup failed (continuing)", {
      sandboxDir,
      error: errToString(err),
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// CI polling — uses `gh` to read the rollup status of the PR
// ────────────────────────────────────────────────────────────────────

interface CIWaitResult {
  outcome: "pass" | "fail" | "skipped";
  durationMs: number;
  summary: string;
}

async function waitForCI(args: {
  sandboxDir: string;
  prNumber: number;
  gitRepositoryRef: string;
}): Promise<CIWaitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + CI_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (shuttingDown) {
      return {
        outcome: "skipped",
        durationMs: Date.now() - startedAt,
        summary: "shutdown during CI wait",
      };
    }

    try {
      const result = await runShellCmdCapture("gh", [
        "pr",
        "checks",
        String(args.prNumber),
        "-R",
        args.gitRepositoryRef,
        "--json",
        // `bucket` categorises each check's state into one of:
        //   pass | fail | pending | skipping | cancel
        // Earlier code referenced `conclusion` which is not a valid field
        // on `gh pr checks --json`; gh exited 0 with empty stdout + an
        // error on stderr, so JSON.parse threw on every poll iteration
        // and the loop ran out the 20-minute timeout instead of resolving.
        "name,bucket",
      ], { cwd: args.sandboxDir });

      // gh exits non-zero with stderr "no checks reported on the '<branch>'
      // branch" when the PR has no associated workflow runs. Treat that
      // (and any other non-zero exit with empty stdout) as "no checks
      // configured" — advisory skip — rather than letting JSON.parse on
      // empty stdout throw and burn the 20-minute poll budget.
      if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
        if (result.stderr.includes("no checks reported")) {
          return {
            outcome: "skipped",
            durationMs: Date.now() - startedAt,
            summary: "no CI checks registered on this PR",
          };
        }
        // Some other gh failure mode — log and keep polling within the
        // existing budget; transient errors (rate limits, network) clear.
        log("debug", "gh pr checks returned non-success; will retry", {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 200),
        });
        await sleep(CI_POLL_INTERVAL_MS);
        continue;
      }

      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
      }>;

      // No checks reported via JSON either → also treat as skipped.
      if (checks.length === 0) {
        return {
          outcome: "skipped",
          durationMs: Date.now() - startedAt,
          summary: "no CI checks registered on this PR",
        };
      }

      const pending = checks.filter((c) => c.bucket === "pending");
      const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");

      if (pending.length === 0) {
        if (failed.length > 0) {
          return {
            outcome: "fail",
            durationMs: Date.now() - startedAt,
            summary: `${failed.length} CI checks failed: ${failed.map((c) => c.name).join(", ")}`,
          };
        }
        return {
          outcome: "pass",
          durationMs: Date.now() - startedAt,
          summary: `${checks.length} CI checks passed`,
        };
      }
    } catch (err) {
      // Likely no checks yet, or gh transient error. Keep polling.
      log("debug", "ci poll iter error (continuing)", { error: errToString(err) });
    }

    await sleep(CI_POLL_INTERVAL_MS);
  }

  return {
    outcome: "fail",
    durationMs: Date.now() - startedAt,
    summary: `CI wait timed out after ${Math.round(CI_POLL_TIMEOUT_MS / 60_000)}m`,
  };
}

// ────────────────────────────────────────────────────────────────────
// HTTP — Major API
// ────────────────────────────────────────────────────────────────────

interface ClaimResponse {
  claimed: boolean;
  brief: {
    id: number;
    title: string;
    status: string;
    classifications: string[];
    expectedArtifactType: string | null;
    expectedPaths: string[];
    baseBranch: string | null;
    gitRepositoryRef: string | null;
    contentMd: string;
    currentRevisionId: number | null;
  };
  run: {
    id: number;
    purpose: "execute" | "review" | "triage" | "repair";
    leaseExpiresAt: string;
    sandboxRef: string | null;
  };
}

interface VerificationPayload {
  // snake_case mirrors the major-finalize-run wire contract; the SQL
  // function passes p_verification_results straight to the verification_results
  // INSERT, so any camelCase keys land as NULL and trip NOT NULL constraints.
  check_name: string;
  outcome: "pass" | "fail" | "skipped";
  required: boolean;
  requiredness_source:
    | "artifact-type-policy"
    | "ready-for-agent-content"
    | "human-override"
    | "automated-acceptance-policy";
  payload: Record<string, unknown>;
}

interface ArtifactPayload {
  // snake_case for the same reason as VerificationPayload above.
  artifact_type: "git-change" | "triage-change-set";
  external_ref: string | null;
  payload: Record<string, unknown>;
}

interface TelemetryPayload {
  observationType: string;
  payload: Record<string, unknown>;
}

async function callHeartbeat(args: { initial: boolean }): Promise<void> {
  // API contract (major-heartbeat): { shellId, runId?, leaseMinutes? }
  // Returns { renewedRun, leaseExpiresAt }. If runId is set and renewedRun=false
  // the run was cancelled (reaper, repair, etc.) and the Shell should abort
  // gracefully. v1 does not consume the metadata field; we drop it and surface
  // it through telemetry separately if needed.
  const body: { shellId: string; runId?: number } = {
    shellId: env.shellId,
  };
  if (activeRun?.runId) body.runId = activeRun.runId;
  void args.initial;
  await majorApiPost("major-heartbeat", body);
}

async function callClaimItem(): Promise<ClaimResponse | null> {
  const body = {
    shellId: env.shellId,
    capabilities: {
      // v1: a single Shell image supports both artifact types implicitly.
      supportedArtifactTypes: ["git-change", "triage-change-set"],
    },
  };
  const resp = (await majorApiPost("major-claim-brief", body)) as Partial<ClaimResponse> | null;
  if (!resp || !resp.claimed) return null;
  return resp as ClaimResponse;
}

async function callFinalizeRun(args: {
  runId: number;
  briefId: number;
  outcome: "succeeded" | "failed" | "cancelled";
  cancellationReason:
    | "human-cancellation"
    | "system-cancellation"
    | "lease-expired"
    | "repair-acquisition"
    | null;
  nextBriefStatus: string;
  verifications: VerificationPayload[];
  artifacts: ArtifactPayload[];
  telemetry: TelemetryPayload[];
  summary: string;
  /** stream-json 'result' event body; forwarded to major-finalize-run for metric hoisting. */
  tachikomaCompletion?: Record<string, unknown>;
}): Promise<void> {
  // API contract (major-finalize-run):
  //   { runId, outcome, nextStatus, handoffReason?, cancellationReason?,
  //     verificationResults?, artifacts?, actor? }
  // The API derives its own idempotency key from runId+outcome and looks up
  // briefId via the run row. shellId / telemetry / summary aren't part of
  // the v1 finalize contract — telemetry recording becomes a follow-up
  // (separate POST to a future major-record-telemetry endpoint, or a column
  // expansion on finalize). Tracked as a Phase 3 limitation in the runbook.
  const body: {
    runId: number;
    outcome: "succeeded" | "failed" | "cancelled";
    nextStatus: string;
    handoffReason?: string;
    cancellationReason?: string;
    verificationResults?: VerificationPayload[];
    artifacts?: ArtifactPayload[];
    tachikomaCompletion?: Record<string, unknown>;
  } = {
    runId: args.runId,
    outcome: args.outcome,
    nextStatus: args.nextBriefStatus,
    verificationResults: args.verifications,
    artifacts: args.artifacts,
  };
  if (args.cancellationReason) body.cancellationReason = args.cancellationReason;
  if (args.nextBriefStatus === "ready-for-human") {
    body.handoffReason = args.summary || "shell reported handoff (see shell logs)";
  }
  if (args.tachikomaCompletion !== undefined) {
    body.tachikomaCompletion = args.tachikomaCompletion;
  }
  void args.briefId;
  void args.telemetry;
  await majorApiPost("major-finalize-run", body);
}

async function callRecordTelemetry(args: {
  runId: number;
  observationType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<void> {
  await majorApiPost("major-record-telemetry", {
    run_id: args.runId,
    observation_type: args.observationType,
    payload: args.payload,
    idempotency_key: args.idempotencyKey,
  });
}

/**
 * POST helper with retry + exponential backoff.
 * Throws on persistent failure after MAX_HTTP_RETRIES; caller decides what to
 * do (most callers swallow + log + continue).
 */
async function majorApiPost(endpoint: string, body: unknown): Promise<unknown> {
  const url = `${env.apiBaseUrl}/${endpoint}`;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Service-role bypass: _shared/auth.ts recognizes the project's
          // service role key as the bearer when X-Major-Shell-Id is set,
          // and attributes the call to shell:<shellId>.
          Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
          "X-Major-Shell-Id": env.shellId,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        // 4xx is permanent (auth, validation); don't retry.
        if (resp.status >= 400 && resp.status < 500) {
          const text = await resp.text();
          throw new Error(`HTTP ${resp.status} on ${endpoint}: ${text.slice(0, 500)}`);
        }
        // 5xx + network: retry.
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status} on ${endpoint} (retryable): ${text.slice(0, 500)}`);
      }

      const ct = resp.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        return await resp.json();
      }
      return await resp.text();
    } catch (err) {
      lastErr = err;
      // 4xx errors above don't reach here — they re-throw with no "retryable" tag.
      // Anything else (5xx / network) gets a backoff tick.
      const isRetryable = errToString(err).includes("retryable") || errToString(err).includes("fetch");
      if (!isRetryable && attempt > 0) break; // 4xx — give up immediately
      if (attempt < MAX_HTTP_RETRIES) {
        const backoff = HTTP_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 250);
        log("warn", "major-api retry", { endpoint, attempt: attempt + 1, backoffMs: backoff });
        await sleep(backoff);
      }
    }
  }
  throw lastErr ?? new Error(`major-api ${endpoint} failed after retries`);
}

// ────────────────────────────────────────────────────────────────────
// Tachikoma output parsers
// ────────────────────────────────────────────────────────────────────

interface ImplementerOutput {
  ok: boolean;
  commits?: string[];
  pr_url?: string;
  pr_number?: number;
  head_sha?: string;
  files_touched?: string[];
  verifications?: Array<{ check: string; outcome: string; duration_ms?: number }>;
  ci_runs_attempted?: number;
  iterations?: Record<string, number>;
  bail_reason?: string;
}

function parseImplementerOutput(raw: unknown): ImplementerOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.phase !== "implementer") return null;
  return obj as unknown as ImplementerOutput;
}

function implementerOutputBailReason(out: ImplementerOutput | null): string | null {
  if (!out || out.ok) return null;
  return out.bail_reason ?? null;
}

interface ReviewerOutput {
  ok: boolean;
  status: "pass" | "fail" | "pending";
  issue_count?: { major: number; minor: number };
  comments_posted?: number;
  scope_match?: "ok" | "out-of-scope-files";
  head_sha?: string;
}

function parseReviewerOutput(raw: unknown): ReviewerOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.phase !== "reviewer") return null;
  if (obj.status !== "pass" && obj.status !== "fail" && obj.status !== "pending") return null;
  return obj as unknown as ReviewerOutput;
}

async function readTelemetryJsonl(): Promise<TelemetryPayload[]> {
  const file = path.join("/work", ".major", "telemetry.jsonl");
  try {
    const content = await fs.readFile(file, "utf8");
    const records: TelemetryPayload[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const ot = typeof parsed.observation_type === "string" ? parsed.observation_type : null;
        if (!ot) continue;
        records.push({
          observationType: ot,
          payload: (parsed.payload as Record<string, unknown>) ?? {},
        });
      } catch {
        // Skip malformed line.
      }
    }
    // Reset the file so a follow-up Run on the same sandbox dir doesn't
    // double-report. (Sandbox is wiped anyway, but defense-in-depth.)
    await fs.writeFile(file, "", "utf8");
    return records;
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ────────────────────────────────────────────────────────────────────

async function gracefulShutdown(): Promise<void> {
  if (!activeRun) return;
  log("info", "cancelling active run on shutdown", { runId: activeRun.runId });
  try {
    await callFinalizeRun({
      runId: activeRun.runId,
      briefId: activeRun.briefId,
      outcome: "cancelled",
      cancellationReason: "system-cancellation",
      // Per SPEC §Cancellation and handoff: System Run Cancellation routes
      // to ready-for-agent if clean retry, ready-for-human if unsafe.
      // We don't know how far the Tachikoma got mid-shutdown; pick the safer
      // ready-for-human so a human can decide. If implementer already pushed
      // commits, the next Run will reuse the branch anyway.
      nextBriefStatus: activeRun.implementerOutput?.pr_url ? "ready-for-human" : "ready-for-agent",
      verifications: [],
      artifacts: [],
      telemetry: [
        {
          observationType: "system-shutdown",
          payload: {
            shellId: env.shellId,
            stage: activeRun.implementerOutput ? "post-implementer" : "pre-implementer",
          },
        },
      ],
      summary: "shell received SIGTERM; cancelling in-flight run",
    });
  } catch (err) {
    log("error", "graceful shutdown finalize failed; reaper will handle", {
      error: errToString(err),
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// Subprocess (Unix shell) helpers
// ────────────────────────────────────────────────────────────────────
//
// These wrap shell-out calls (git, gh) — "shell" here means the Unix sense
// (a subprocess running a command), NOT a Major Shell. Per ADR 004 the
// Unix sense keeps lowercase wording; capitalized Shell is the Major Shell.

interface ShellCmdCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runShellCmd(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  const { exitCode, stderr } = await runShellCmdCapture(cmd, args, opts);
  if (exitCode !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }
}

async function runShellCmdCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<ShellCmdCapture> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

// ────────────────────────────────────────────────────────────────────
// Logging + small utils
// ────────────────────────────────────────────────────────────────────

function log(level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    shellId: env?.shellId ?? "(uninitialized)",
    message,
    ...(meta ?? {}),
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ────────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  // Any unhandled error here means the daemon couldn't start — exit non-zero
  // so the container restarts (per Docker restart policy).
  process.stderr.write(`[fatal] ${errToString(err)}\n`);
  process.exit(1);
});
