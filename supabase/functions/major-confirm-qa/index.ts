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
    .select("id, status")
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

  return jsonResponse({ briefId, status: "done" });
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
