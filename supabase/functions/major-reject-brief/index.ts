// supabase/functions/major-reject-brief/index.ts
//
// POST /major-reject-brief
//   body: { briefId: number, reason: string }
//   200:  { briefId, status: 'wontfix' }
//
// Human-only rejection. Transitions a Brief to `wontfix` from any non-
// terminal status and records a `rejected` Event with the reason.
//
// `Deno.serve` is wrapped in `if (import.meta.main)` so the test file can
// `import { rejectBriefCore } from "./index.ts"` without binding a network port.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";
import type { MajorClient } from "../_shared/auth.ts";
import {
  postResolutionAndClose,
  type ResolutionVerification,
} from "../_shared/github-issue.ts";

interface RejectBody {
  briefId: number;
  reason: string;
}

export async function rejectBriefCore(
  client: MajorClient,
  briefId: number,
  reason: string,
  actor: string,
): Promise<Response> {
  const { data: prev, error: fetchErr } = await client
    .from("briefs")
    .select("id, status, source_issue_repo, source_issue_number, title, pr_url")
    .eq("id", briefId)
    .single();
  if (fetchErr) {
    console.error("[major-reject-brief] brief fetch failed:", fetchErr);
    return errorResponse("Brief not found", 404);
  }
  if (!prev) return errorResponse("Brief not found", 404);
  if (prev.status === "done" || prev.status === "wontfix") {
    return errorResponse(`Brief is already terminal (${prev.status})`, 409);
  }

  const { error: updErr } = await client
    .from("briefs")
    .update({ status: "wontfix" })
    .eq("id", briefId);
  if (updErr) {
    console.error("[major-reject-brief] update failed:", updErr);
    return errorResponse("Internal server error", 500);
  }

  // F-02: baseDelivery is deterministic (no Date.now()); idempotent on replay.
  const baseDelivery = `reject-${briefId}`;
  await client.from("events").insert([
    {
      brief_id: briefId,
      type: "rejected",
      actor,
      payload: { reason, prev_status: prev.status },
      idempotency_key: deriveIdempotencyKey(briefId, "rejected", actor, baseDelivery),
    },
    {
      brief_id: briefId,
      type: "status-transitioned",
      actor,
      payload: { from: prev.status, to: "wontfix" },
      idempotency_key: deriveIdempotencyKey(
        briefId,
        "status-transitioned",
        actor,
        baseDelivery,
      ),
    },
  ]);

  // ADR 011: post resolution comment and close source GitHub issue.
  const issueRepo = prev.source_issue_repo;
  const issueNumber = prev.source_issue_number;
  if (typeof issueRepo === "string" && typeof issueNumber === "number") {
    const verificationResults = await fetchVerificationResults(client, briefId);
    const resolution = await postResolutionAndClose({
      issueRepo,
      issueNumber,
      brief: {
        id: briefId,
        title: typeof prev.title === "string" ? prev.title : "",
        pr_url: typeof prev.pr_url === "string" ? prev.pr_url : null,
        status: "wontfix",
      },
      verificationResults,
      closeReason: "not_planned",
      rejectionReason: reason,
    });
    if (!resolution.ok) {
      console.error("[major-reject-brief] issue-close-failed:", {
        briefId,
        issueRepo,
        issueNumber,
        error: resolution.error,
      });
      await client
        .from("telemetry_records")
        .insert({
          observation_type: "external-system-error",
          brief_id: briefId,
          run_id: null,
          idempotency_key: deriveIdempotencyKey(
            briefId,
            "issue-close-failed",
            actor,
            baseDelivery,
          ),
          payload: {
            error: resolution.error,
            source_issue_repo: issueRepo,
            source_issue_number: issueNumber,
          },
        })
        .select();
    }
  }

  return jsonResponse({ briefId, status: "wontfix" });
}

async function fetchVerificationResults(
  client: MajorClient,
  briefId: number,
): Promise<ResolutionVerification[]> {
  const { data: latestRun } = await client
    .from("runs")
    .select("id")
    .eq("brief_id", briefId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRun) return [];
  const { data: rows } = await client
    .from("verification_results")
    .select("check_name, outcome, required")
    .eq("run_id", latestRun.id);
  if (!rows) return [];
  return rows.map((r) => ({
    check_name: r.check_name as string,
    outcome: r.outcome as string,
    required: r.required as boolean,
  }));
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    const preflight = handleOptions(req);
    if (preflight) return preflight;

    if (req.method !== "POST") return errorResponse("Method not allowed", 405);

    try {
      const auth = await authenticate(req);
      if (!auth.ok) return errorResponse(auth.message, auth.status);

      const body = (await req.json()) as RejectBody;
      if (!body?.briefId || !body.reason || typeof body.reason !== "string") {
        return errorResponse("Invalid body — expected { briefId, reason }", 400);
      }

      return await rejectBriefCore(auth.client, body.briefId, body.reason, auth.actor);
    } catch (err) {
      console.error("[major-reject-brief]", err);
      return errorResponse("Internal server error", 500);
    }
  });
}
