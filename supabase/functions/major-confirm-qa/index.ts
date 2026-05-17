// supabase/functions/major-confirm-qa/index.ts
//
// POST /major-confirm-qa
//   body: { briefId: number }
//   200:  { briefId, status: 'done' }
//   409:  if Brief is not in 'ready-for-review' or PR is not merged
//
// Human-only acceptance. Transitions a Brief from `ready-for-review` to
// `done` and records an `accepted` Event attributed to the authenticated
// human actor. This is the only path to `done` in v1 (no automated
// acceptance policy is wired).
//
// `Deno.serve` is wrapped in `if (import.meta.main)` so the test file can
// `import { confirmQaCore } from "./index.ts"` without binding a network port.

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

interface ConfirmBody {
  briefId: number;
}

export async function confirmQaCore(
  client: MajorClient,
  briefId: number,
  actor: string,
): Promise<Response> {
  // Conditional update: only succeeds if the Brief is ready-for-review AND PR is merged.
  // F-19: the .eq("pr_status", "merged") guard prevents confirming QA on an unmerged PR.
  const { data, error } = await client
    .from("briefs")
    .update({ status: "done" })
    .eq("id", briefId)
    .eq("status", "ready-for-review")
    .eq("pr_status", "merged")
    .select("id, status, source_issue_repo, source_issue_number, title, pr_url")
    .maybeSingle();

  if (error) {
    console.error("[major-confirm-qa] update failed:", error);
    return errorResponse("Internal server error", 500);
  }
  if (!data) {
    return errorResponse(
      "Brief is not in 'ready-for-review' or PR is not merged; cannot confirm QA",
      409,
    );
  }

  // Both `accepted` and `status-transitioned` Events for traceability.
  // F-02: baseDelivery is deterministic (no Date.now()); keys are per-actor
  // via deriveIdempotencyKey(briefId, type, actor, delivery).
  const baseDelivery = `qa-confirm-${briefId}`;
  await client.from("events").insert([
    {
      brief_id: briefId,
      type: "accepted",
      actor,
      payload: { reason: "qa-confirmed" },
      idempotency_key: deriveIdempotencyKey(briefId, "accepted", actor, baseDelivery),
    },
    {
      brief_id: briefId,
      type: "status-transitioned",
      actor,
      payload: { from: "ready-for-review", to: "done" },
      idempotency_key: deriveIdempotencyKey(
        briefId,
        "status-transitioned",
        actor,
        baseDelivery,
      ),
    },
  ]);

  // ADR 011: post resolution comment and close source GitHub issue.
  const issueRepo = data.source_issue_repo;
  const issueNumber = data.source_issue_number;
  if (typeof issueRepo === "string" && typeof issueNumber === "number") {
    const verificationResults = await fetchVerificationResults(client, briefId);
    const resolution = await postResolutionAndClose({
      issueRepo,
      issueNumber,
      brief: {
        id: briefId,
        title: typeof data.title === "string" ? data.title : "",
        pr_url: typeof data.pr_url === "string" ? data.pr_url : null,
        status: "done",
      },
      verificationResults,
      closeReason: "completed",
    });
    if (!resolution.ok) {
      console.error("[major-confirm-qa] issue-close-failed:", {
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

  return jsonResponse({ briefId, status: "done" });
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

      const body = (await req.json()) as ConfirmBody;
      if (!body?.briefId) {
        return errorResponse("Invalid body — expected { briefId }", 400);
      }

      return await confirmQaCore(auth.client, body.briefId, auth.actor);
    } catch (err) {
      console.error("[major-confirm-qa]", err);
      return errorResponse("Internal server error", 500);
    }
  });
}
