// supabase/functions/major-auto-triage-sessions/index.ts
//
// POST /major-auto-triage-sessions
//   body: {} (no required fields)
//   200: {
//     processed: number,
//     triaged: number,
//     needs_human_apply: number,
//     failed: number,
//     results: SessionResult[]
//   }
//
// Fetches every open triage session and auto-triages each one:
//   1. For GitHub-triggered sessions, fetches the full issue body from the
//      GitHub API (using GITHUB_APP_TOKEN).
//   2. Calls Claude to generate a Brief PRD, classifications, and expected paths.
//   3. Runs the path-blocker check. If blocked: marks needs_human_apply and
//      still closes the session so the change set sits in Pending QA.
//   4. Inserts a triage_change_set + two ops (create-brief + set-ready-state
//      with brief_id="__auto__" resolved by the apply_change_set RPC).
//   5. Injects an "auto-triaged" message into the session transcript.
//   6. Closes the session and, if path-blocker is clear, applies the change set.
//
// Processing is serial — predictable cost, easy error attribution.
// Each session result is returned even on failure so the UI can report outcomes.
//
// Note: for large session counts this function can approach Supabase's default
// edge-function timeout. Contact Supabase support to extend if needed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate, type MajorClient } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { checkPathBlocker } from "../_shared/path_blocker.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

const GITHUB_API = "https://api.github.com";
const AUTO_TRIAGE_ACTOR = "major:auto-triage";

interface GithubTrigger {
  source_issue_repo: string;
  source_issue_number: number;
  source_issue_title: string;
}

interface TranscriptMessage {
  role: string;
  content: string;
  ts: string;
}

interface Session {
  id: number;
  status: string;
  entry_point: string | null;
  trigger_payload: GithubTrigger | Record<string, unknown> | null;
  transcript: TranscriptMessage[];
  draft_prd: string | null;
}

interface PathBlockerConfig {
  protected_globs: string[];
  mass_rerank_threshold: number;
}

interface TriageDecision {
  summary: string;
  prd: string;
  classifications: string[];
  expected_paths: string[];
  is_spike: boolean;
}

interface SessionResult {
  sessionId: number;
  title: string;
  outcome: "triaged" | "needs_human_apply" | "failed";
  changeSetId?: number;
  summary: string;
  error?: string;
}

function isGithubTrigger(payload: unknown): payload is GithubTrigger {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "source_issue_title" in (payload as object)
  );
}

function getSessionTitle(session: Session): string {
  if (isGithubTrigger(session.trigger_payload)) {
    return session.trigger_payload.source_issue_title;
  }
  if (session.draft_prd) {
    const match = session.draft_prd.match(/^#\s+(.+)/m);
    if (match) return match[1];
  }
  return `Session #${session.id}`;
}

async function fetchIssueBody(
  repo: string,
  number: number,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { body?: string | null };
    return typeof data.body === "string" ? data.body : null;
  } catch {
    return null;
  }
}

async function callClaude(
  title: string,
  body: string | null,
  repo: string | null,
  transcript: TranscriptMessage[],
): Promise<TriageDecision> {
  const oauthToken = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!oauthToken && !apiKey) throw new Error("No Anthropic auth configured — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");

  const anthropic = oauthToken
    ? new Anthropic({ authToken: oauthToken, maxRetries: 4 })
    : new Anthropic({ apiKey: apiKey!, maxRetries: 4 });

  const contextParts: string[] = [];
  if (repo) contextParts.push(`Repository: ${repo}`);
  contextParts.push(`Title: ${title}`);
  if (body) contextParts.push(`\nIssue body:\n${body}`);
  if (transcript.length > 0) {
    const formatted = transcript
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");
    contextParts.push(`\nSession transcript:\n${formatted}`);
  }

  const userMessage = contextParts.join("\n");

  const response = await anthropic.messages.create({
    model: Deno.env.get("AUTO_TRIAGE_MODEL") ?? "claude-sonnet-4-6",
    max_tokens: 4096,
    system: `You are Major's auto-triage AI. Major is a software orchestration system where AI coding agents implement work items called Briefs. Your job is to read a GitHub issue and produce a Brief that's ready for an agent to implement.

## Bias toward action
- Always produce a ready-for-agent Brief. Never refuse or ask for clarification.
- If the issue is clear and detailed: write a specific, actionable PRD with acceptance criteria.
- If the issue is vague or missing implementation detail: write a spike PRD directing the agent to research and make their best attempt. Agents are capable — let them figure out ambiguities and document their guesses in the PR.

## Classifications
Choose one or more: bug-fix, feature, refactor, docs

## Expected paths
Provide your best-guess list of file paths in the repo that this Brief will likely touch. Be specific. These are used for routing decisions — don't be overly conservative.

## PRD format for a regular Brief:
# <Title>

## Background
<why this matters, 1-2 sentences>

## Directive
<what the agent should implement>

## Acceptance Criteria
- [ ] <specific, verifiable criterion>
- [ ] <another criterion>

## Notes
<any important context, constraints, or hints>

## PRD format for a spike:
# Spike: <Title>

## Background
<context>

## Directive
Research this issue and make your best attempt at a solution. Document any guesses or assumptions clearly in the PR description for human review.

## What to investigate
- <key question or unknown>
- <another unknown>`,
    tools: [
      {
        name: "produce_brief",
        description:
          "Produce a Brief for this issue. Always call this tool — never respond in plain text.",
        input_schema: {
          type: "object" as const,
          properties: {
            summary: {
              type: "string",
              description: "One sentence (max 120 chars) describing the decision",
            },
            prd: {
              type: "string",
              description: "Full Markdown PRD content",
            },
            classifications: {
              type: "array",
              items: { type: "string" },
              description: "Array of classifications: bug-fix, feature, refactor, and/or docs",
            },
            expected_paths: {
              type: "array",
              items: { type: "string" },
              description: "File paths this Brief will likely touch",
            },
            is_spike: {
              type: "boolean",
              description: "true if this is a research spike",
            },
          },
          required: ["summary", "prd", "classifications", "expected_paths", "is_spike"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "produce_brief" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not call produce_brief");
  }

  const input = toolUse.input as Record<string, unknown>;
  return {
    summary: typeof input.summary === "string" ? input.summary : "Auto-triaged",
    prd: typeof input.prd === "string" ? input.prd : `# ${title}\n\nAuto-generated spike.`,
    classifications: Array.isArray(input.classifications)
      ? (input.classifications as string[]).filter((c) =>
          ["bug-fix", "feature", "refactor", "docs"].includes(c)
        )
      : ["feature"],
    expected_paths: Array.isArray(input.expected_paths)
      ? (input.expected_paths as string[]).filter((p) => typeof p === "string")
      : [],
    is_spike: typeof input.is_spike === "boolean" ? input.is_spike : false,
  };
}

async function processSession(
  session: Session,
  client: MajorClient,
  pbConfig: PathBlockerConfig,
  githubToken: string | undefined,
  actor: string,
): Promise<SessionResult> {
  const title = getSessionTitle(session);

  try {
    // ── 1. Gather issue context ─────────────────────────────────────
    let issueBody: string | null = null;
    let repo: string | null = null;
    let issueNumber: number | null = null;

    if (isGithubTrigger(session.trigger_payload)) {
      repo = session.trigger_payload.source_issue_repo;
      issueNumber = session.trigger_payload.source_issue_number;
      if (githubToken && repo && issueNumber) {
        issueBody = await fetchIssueBody(repo, issueNumber, githubToken);
      }
    }

    const hasContent =
      repo || issueBody || session.transcript.length > 0 || session.draft_prd;
    if (!hasContent) {
      return {
        sessionId: session.id,
        title,
        outcome: "failed",
        summary: "No content to triage",
        error: "Session has no GitHub trigger, transcript, or draft PRD.",
      };
    }

    // ── 2. Call Claude ──────────────────────────────────────────────
    const decision = await callClaude(
      title,
      issueBody,
      repo,
      session.transcript,
    );

    // ── 3. Path-blocker check ───────────────────────────────────────
    const blocker = checkPathBlocker(decision.expected_paths, 0, {
      protectedGlobs: pbConfig.protected_globs,
      massRerankThreshold: pbConfig.mass_rerank_threshold,
    });

    // ── 4. Insert change set ────────────────────────────────────────
    const { data: changeSet, error: setErr } = await client
      .from("triage_change_sets")
      .insert({
        triage_session_id: session.id,
        decision: "proposed",
        summary: decision.summary,
        needs_human_apply: blocker.needsHumanApply,
        blocker_reasons: blocker.reasons,
      })
      .select("id")
      .single();

    if (setErr || !changeSet) {
      throw new Error(setErr?.message ?? "change set insert failed");
    }

    const changeSetId = changeSet.id as number;

    // ── 5. Insert ops ───────────────────────────────────────────────
    const createBriefPayload: Record<string, unknown> = {
      classifications: decision.classifications,
      expected_paths: decision.expected_paths,
      content_md: decision.prd,
      git_repository_ref: repo ?? undefined,
      source_session_id: session.id,
      source_issue_repo: repo ?? undefined,
      source_issue_number: issueNumber ?? undefined,
    };

    const ops = [
      {
        change_set_id: changeSetId,
        operation_type: "create-brief",
        payload: createBriefPayload,
        sequence_index: 0,
        status: "proposed",
        idempotency_key: deriveIdempotencyKey(
          null,
          "change-op:create-brief",
          AUTO_TRIAGE_ACTOR,
          `cs-${changeSetId}-seq-0`,
        ),
      },
      {
        change_set_id: changeSetId,
        operation_type: "set-ready-state",
        payload: { brief_id: "__auto__", ready: true },
        sequence_index: 1,
        status: "proposed",
        idempotency_key: deriveIdempotencyKey(
          null,
          "change-op:set-ready-state",
          AUTO_TRIAGE_ACTOR,
          `cs-${changeSetId}-seq-1`,
        ),
      },
    ];

    const { error: opsErr } = await client
      .from("triage_change_operations")
      .insert(ops);

    if (opsErr) {
      throw new Error(opsErr.message);
    }

    // ── 6. Inject auto-triage message + close session ───────────────
    const autoMsg: TranscriptMessage = {
      role: "agent",
      content: blocker.needsHumanApply
        ? `Auto-triage proposed Brief "${title}" but it needs human review. Path-blocker: ${blocker.reasons.join("; ")}. Change set #${changeSetId} is in Pending QA.`
        : `Auto-triaged: ${decision.is_spike ? "Created spike Brief" : "Created Brief"} for "${title}" and set ready-for-agent. ${decision.summary}`,
      ts: new Date().toISOString(),
    };

    await client
      .from("triage_sessions")
      .update({
        status: "closed",
        transcript: [...session.transcript, autoMsg],
      })
      .eq("id", session.id);

    // ── 7. Apply change set if path-blocker cleared ─────────────────
    if (!blocker.needsHumanApply) {
      const { error: applyErr } = await client.rpc("apply_change_set", {
        p_change_set_id: changeSetId,
        p_actor: actor,
        p_idempotency_root: `auto-triage-${changeSetId}`,
      });

      if (applyErr) {
        console.error(
          `[major-auto-triage-sessions] apply RPC failed for session ${session.id}:`,
          applyErr,
        );
        return {
          sessionId: session.id,
          title,
          outcome: "failed",
          changeSetId,
          summary: decision.summary,
          error: `Change set created but apply failed: ${applyErr.message}`,
        };
      }
    }

    return {
      sessionId: session.id,
      title,
      outcome: blocker.needsHumanApply ? "needs_human_apply" : "triaged",
      changeSetId,
      summary: decision.summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[major-auto-triage-sessions] session ${session.id} failed:`,
      message,
    );
    return {
      sessionId: session.id,
      title,
      outcome: "failed",
      summary: "Auto-triage failed",
      error: message,
    };
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const githubToken = Deno.env.get("GITHUB_APP_TOKEN");

    // Fetch path-blocker config (required for blocker check).
    const { data: pbConfig, error: pbErr } = await auth.client
      .from("path_blocker_config")
      .select("protected_globs, mass_rerank_threshold")
      .eq("id", 1)
      .single();

    if (pbErr || !pbConfig) {
      return errorResponse("path_blocker_config missing", 500);
    }

    // Fetch all open sessions.
    const { data: sessions, error: sessErr } = await auth.client
      .from("triage_sessions")
      .select("id, status, entry_point, trigger_payload, transcript, draft_prd")
      .eq("status", "open")
      .order("id", { ascending: true });

    if (sessErr) {
      return errorResponse(sessErr.message, 500);
    }

    if (!sessions || sessions.length === 0) {
      return jsonResponse({ processed: 0, triaged: 0, needs_human_apply: 0, failed: 0, results: [] });
    }

    // Process sessions serially with a 1-second gap to avoid burst rate limits.
    const typedSessions = sessions as Session[];
    const results: SessionResult[] = [];
    for (let i = 0; i < typedSessions.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1000));
      const result = await processSession(
        typedSessions[i],
        auth.client,
        pbConfig as PathBlockerConfig,
        githubToken,
        auth.actor,
      );
      results.push(result);
    }

    const triaged = results.filter((r) => r.outcome === "triaged").length;
    const needsHumanApply = results.filter((r) => r.outcome === "needs_human_apply").length;
    const failed = results.filter((r) => r.outcome === "failed").length;

    return jsonResponse({
      processed: results.length,
      triaged,
      needs_human_apply: needsHumanApply,
      failed,
      results,
    });
  } catch (err) {
    console.error("[major-auto-triage-sessions]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
