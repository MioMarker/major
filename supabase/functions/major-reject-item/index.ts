// supabase/functions/major-reject-item/index.ts
//
// POST /major-reject-item
//   body: { briefId: number, reason: string }
//   200:  { briefId, status: 'wontfix' }
//
// Human-only rejection. Transitions a Brief to `wontfix` from any non-
// terminal status and records a `rejected` Event with the reason.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface RejectBody {
  briefId: number;
  reason: string;
}

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

    const { data: prev, error: fetchErr } = await auth.client
      .from("work_items")
      .select("id, status")
      .eq("id", body.briefId)
      .single();
    if (fetchErr || !prev) return errorResponse(fetchErr?.message ?? "brief not found", 404);
    if (prev.status === "done" || prev.status === "wontfix") {
      return errorResponse(`Brief is already terminal (${prev.status})`, 409);
    }

    const { error: updErr } = await auth.client
      .from("work_items")
      .update({ status: "wontfix" })
      .eq("id", body.briefId);
    if (updErr) {
      console.error("[major-reject-item] update failed:", updErr);
      return errorResponse(updErr.message, 500);
    }

    const baseDelivery = `reject-${body.briefId}-${Date.now()}`;
    await auth.client.from("events").insert([
      {
        work_item_id: body.briefId,
        type: "rejected",
        actor: auth.actor,
        payload: { reason: body.reason, prev_status: prev.status },
        idempotency_key: deriveIdempotencyKey(body.briefId, "rejected", auth.actor, baseDelivery),
      },
      {
        work_item_id: body.briefId,
        type: "status-transitioned",
        actor: auth.actor,
        payload: { from: prev.status, to: "wontfix" },
        idempotency_key: deriveIdempotencyKey(
          body.briefId,
          "status-transitioned",
          auth.actor,
          baseDelivery,
        ),
      },
    ]);

    return jsonResponse({ briefId: body.briefId, status: "wontfix" });
  } catch (err) {
    console.error("[major-reject-item]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
