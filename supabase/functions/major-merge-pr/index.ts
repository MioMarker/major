// supabase/functions/major-merge-pr/index.ts
//
// POST /major-merge-pr
//   body: { briefId: number }
//   200:  { outcome: 'merged',  pr_url }
//   200:  { outcome: 'blocked', reason, github_response }
//
// Mode 1 backend — single per-PR approve + squash-merge attempt. The
// browser orchestrates the batch loop (Mode 1 is tab-bound, ADR 016 § Q6);
// this function handles one PR per call.
//
// Algorithm: per ADR 017 path (b) — approve, then squash-merge. No
// pre-flight; pre-flight is deferred to ADR 017's later implementation.
//
// Outcome semantics:
//   - merged   → GitHub accepted both calls. The `→ done` transition is
//                written by ADR 007's PR-merge webhook handler; this
//                function deliberately does NOT write it.
//   - blocked  → either call failed. Brief is transitioned to
//                `merge-blocked` per ADR 016 with a closed-set reason
//                and an event echoing the GitHub response.
//
// The Brief is only eligible when status ∈ ('ready-for-review',
// 'merge-blocked'). Any other status is a 409. A null `pr_url` is a 400.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate, type MajorClient } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";
import {
  type GithubResponseSummary,
  type MergeAttemptFailedReason,
  type MergePrBlockedResponse,
  MergePrRequest,
  type MergePrSuccessResponse,
} from "../_shared/schemas/merge-pr.ts";

const LOG_PREFIX = "[MajorMergePr]";
const GITHUB_API = "https://api.github.com";

// `(owner, repo, n)` from a GitHub PR URL like
//   https://github.com/<owner>/<repo>/pull/<n>
// Returns null on malformed input; the caller surfaces a 400.
function parsePrUrl(prUrl: string): { owner: string; repo: string; number: number } | null {
  try {
    const u = new URL(prUrl);
    if (u.hostname !== "github.com") return null;
    const segments = u.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length < 4) return null;
    const [owner, repo, kind, numberStr] = segments;
    if (kind !== "pull") return null;
    const n = Number(numberStr);
    if (!Number.isInteger(n) || n <= 0) return null;
    return { owner, repo, number: n };
  } catch {
    return null;
  }
}

// Truncate GitHub error bodies so the event payload stays bounded. GitHub
// error responses are typically <1KB; cap at 2KB defensively.
function clampMessage(s: string, max = 2048): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// Classify a non-2xx merge PUT into the closed-set reason codes. GitHub
// returns 405 with a body that mentions "not mergeable" for a merge
// conflict; everything else 4xx/5xx from the merge call is generic
// "merge-rejected". The approval POST has its own classifier below.
function classifyMergeFailure(status: number, body: string): MergeAttemptFailedReason {
  if (status === 405) {
    // GitHub's documented language for an unmergeable PR.
    const lower = body.toLowerCase();
    if (lower.includes("not mergeable") || lower.includes("conflict")) {
      return "merge-conflict";
    }
  }
  return "merge-rejected";
}

async function readGithubError(res: Response): Promise<GithubResponseSummary> {
  const raw = await res.text().catch(() => "");
  return { status: res.status, message: clampMessage(raw) };
}

async function writeMergeBlocked(
  client: MajorClient,
  params: {
    briefId: number;
    fromStatus: string;
    actor: string;
    reason: MergeAttemptFailedReason;
    prUrl: string;
    githubResponse: GithubResponseSummary;
    deliveryId: string;
  },
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  // 1. Atomic, conditional status flip. The eq("status", fromStatus) clause
  // absorbs the race where another Mode 1 attempt (or a webhook) already
  // moved the Brief out from under us — affects 0 rows on race; surface as
  // 409 so the caller can refresh.
  const { data: updated, error: updErr } = await client
    .from("briefs")
    .update({ status: "merge-blocked" })
    .eq("id", params.briefId)
    .in("status", ["ready-for-review", "merge-blocked"])
    .select("id");
  if (updErr) {
    console.error(LOG_PREFIX, "merge-blocked update failed:", updErr);
    return { ok: false, status: 500, message: "Internal server error" };
  }
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      status: 409,
      message: "Brief status changed concurrently; refresh and retry",
    };
  }

  // 2. status-transitioned event. The idempotency key includes a per-call
  // delivery id (timestamp-scoped) so legitimate retries on the same attempt
  // are no-ops but distinct attempts are recorded distinctly.
  const { error: evtErr } = await client.from("events").insert({
    brief_id: params.briefId,
    type: "status-transitioned",
    actor: params.actor,
    payload: {
      from: params.fromStatus,
      to: "merge-blocked",
      merge_attempt_failed_reason: params.reason,
      pr_url: params.prUrl,
      github_response: params.githubResponse,
    },
    idempotency_key: deriveIdempotencyKey(
      params.briefId,
      "status-transitioned",
      params.actor,
      params.deliveryId,
    ),
  });
  if (evtErr) {
    // Brief is already in merge-blocked at this point; the event write
    // failure is logged but does not roll the status back (status is the
    // operator-visible truth; the event is the audit trail).
    console.error(LOG_PREFIX, "event insert failed:", evtErr);
  }

  return { ok: true };
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = MergePrRequest.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.message, 400);
    const { briefId } = parsed.data;

    const { data: brief, error: fetchErr } = await auth.client
      .from("briefs")
      .select("id, status, pr_url")
      .eq("id", briefId)
      .maybeSingle();
    if (fetchErr) {
      console.error(LOG_PREFIX, "brief fetch failed:", fetchErr);
      return errorResponse("Internal server error", 500);
    }
    if (!brief) return errorResponse("Brief not found", 404);

    if (brief.status !== "ready-for-review" && brief.status !== "merge-blocked") {
      return errorResponse(
        `Brief status is '${brief.status}'; merge requires 'ready-for-review' or 'merge-blocked'`,
        409,
      );
    }

    const prUrl: string | null = brief.pr_url ?? null;
    if (!prUrl) {
      return errorResponse("Brief has no pr_url; cannot merge", 400);
    }

    const parsedPr = parsePrUrl(prUrl);
    if (!parsedPr) {
      return errorResponse(`Brief pr_url is not a recognizable GitHub PR URL: ${prUrl}`, 400);
    }

    const githubToken = Deno.env.get("GITHUB_TOKEN");
    if (!githubToken) {
      console.error(LOG_PREFIX, "GITHUB_TOKEN not configured");
      return errorResponse("GITHUB_TOKEN not configured", 500);
    }

    const ghHeaders = {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    const prBase =
      `${GITHUB_API}/repos/${parsedPr.owner}/${parsedPr.repo}/pulls/${parsedPr.number}`;

    // One delivery id covers both the approval call and the failure-path
    // event write so idempotency stays stable across the whole attempt.
    const deliveryId = `merge-pr-${briefId}-${Date.now()}`;

    // 1. Approve the PR.
    const approveRes = await fetch(`${prBase}/reviews`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ event: "APPROVE" }),
    });
    if (!approveRes.ok) {
      const githubResponse = await readGithubError(approveRes);
      console.error(
        LOG_PREFIX,
        `approve failed brief=${briefId} status=${githubResponse.status}`,
      );
      const blockResult = await writeMergeBlocked(auth.client, {
        briefId,
        fromStatus: brief.status,
        actor: auth.actor,
        reason: "approval-rejected",
        prUrl,
        githubResponse,
        deliveryId,
      });
      if (!blockResult.ok) return errorResponse(blockResult.message, blockResult.status);
      const body: MergePrBlockedResponse = {
        outcome: "blocked",
        reason: "approval-rejected",
        github_response: githubResponse,
      };
      return jsonResponse(body);
    }

    // 2. Squash-merge the PR.
    const mergeRes = await fetch(`${prBase}/merge`, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!mergeRes.ok) {
      const githubResponse = await readGithubError(mergeRes);
      const reason = classifyMergeFailure(githubResponse.status, githubResponse.message);
      console.error(
        LOG_PREFIX,
        `merge failed brief=${briefId} status=${githubResponse.status} reason=${reason}`,
      );
      const blockResult = await writeMergeBlocked(auth.client, {
        briefId,
        fromStatus: brief.status,
        actor: auth.actor,
        reason,
        prUrl,
        githubResponse,
        deliveryId,
      });
      if (!blockResult.ok) return errorResponse(blockResult.message, blockResult.status);
      const body: MergePrBlockedResponse = {
        outcome: "blocked",
        reason,
        github_response: githubResponse,
      };
      return jsonResponse(body);
    }

    // Success: ADR 007's webhook handler writes the `→ done` transition.
    const body: MergePrSuccessResponse = { outcome: "merged", pr_url: prUrl };
    return jsonResponse(body);
  } catch (err) {
    console.error(LOG_PREFIX, err);
    return errorResponse("Internal server error", 500);
  }
});
