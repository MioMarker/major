// supabase/functions/major-confirm-qa/index.ts
//
// POST /major-confirm-qa
//   body: { briefId: number }
//   200:  { briefId, status: 'done' }
//   409:  if Brief is not in 'ready-for-review'
//
// Human-only acceptance. Transitions a Brief from `ready-for-review` to
// `done` and records an `accepted` Event attributed to the authenticated
// human actor. This is the only path to `done` in v1 (no automated
// acceptance policy is wired).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface ConfirmBody {
  briefId: number;
}

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

    // Conditional update: only succeeds if the Brief is currently ready-for-review.
    const { data, error } = await auth.client
      .from("work_items")
      .update({ status: "done" })
      .eq("id", body.briefId)
      .eq("status", "ready-for-review")
      .select("id, status")
      .maybeSingle();

    if (error) {
      console.error("[major-confirm-qa] update failed:", error);
      return errorResponse(error.message, 500);
    }
    if (!data) {
      return errorResponse(
        "Brief is not in 'ready-for-review'; cannot confirm QA",
        409,
      );
    }

    // Both `accepted` and `status-transitioned` Events for traceability.
    const baseDelivery = `qa-confirm-${body.briefId}-${Date.now()}`;
    await auth.client.from("events").insert([
      {
        work_item_id: body.briefId,
        type: "accepted",
        actor: auth.actor,
        payload: { reason: "qa-confirmed" },
        idempotency_key: deriveIdempotencyKey(body.briefId, "accepted", auth.actor, baseDelivery),
      },
      {
        work_item_id: body.briefId,
        type: "status-transitioned",
        actor: auth.actor,
        payload: { from: "ready-for-review", to: "done" },
        idempotency_key: deriveIdempotencyKey(
          body.briefId,
          "status-transitioned",
          auth.actor,
          baseDelivery,
        ),
      },
    ]);

    return jsonResponse({ briefId: body.briefId, status: "done" });
  } catch (err) {
    console.error("[major-confirm-qa]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
