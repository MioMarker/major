// supabase/functions/major-rearm-brief/index.ts
//
// POST /major-rearm-brief
//   body: { briefId: number, reason?: string }
//   200:  { briefId, status: 'ready-for-agent' }
//
// Human-only re-arm. Transitions a Brief from `ready-for-human` back to
// `ready-for-agent` so the next idle Shell claims it. Records a `rearmed`
// Event with the optional reason and a `status-transitioned` Event for
// the lifecycle audit trail.
//
// Only `ready-for-human → ready-for-agent` is allowed. Re-arming from a
// terminal status (`done`, `wontfix`) is rejected with 409; re-arming
// from `ready-for-review` would bypass acceptance and is rejected with
// 409 to keep the lifecycle coherent.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface RearmBody {
  briefId: number;
  reason?: string;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as RearmBody;
    if (!body?.briefId || typeof body.briefId !== "number") {
      return errorResponse("Invalid body — expected { briefId, reason? }", 400);
    }

    const { data: prev, error: fetchErr } = await auth.client
      .from("briefs")
      .select("id, status")
      .eq("id", body.briefId)
      .single();
    if (fetchErr || !prev) return errorResponse("Brief not found", 404);
    if (prev.status !== "ready-for-human") {
      return errorResponse(
        `Brief status is '${prev.status}'; re-arm requires 'ready-for-human'`,
        409,
      );
    }

    // Atomic status flip via filtered UPDATE — absorbs the race where two
    // operators click Re-arm simultaneously. Affects 0 rows on race; we
    // surface that as 409 rather than silently inserting duplicate events.
    const { data: updated, error: updErr } = await auth.client
      .from("briefs")
      .update({ status: "ready-for-agent" })
      .eq("id", body.briefId)
      .eq("status", "ready-for-human")
      .select("id");
    if (updErr) {
      console.error("[major-rearm-brief] update failed:", updErr);
      return errorResponse("Internal server error", 500);
    }
    if (!updated || updated.length === 0) {
      return errorResponse("Brief status changed concurrently; refresh and retry", 409);
    }

    const reason = typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : "re-armed via UI";
    const baseDelivery = `rearm-${body.briefId}-${Date.now()}`;
    await auth.client.from("events").insert([
      {
        brief_id: body.briefId,
        type: "rearmed",
        actor: auth.actor,
        payload: { reason, prev_status: prev.status },
        idempotency_key: deriveIdempotencyKey(body.briefId, "rearmed", auth.actor, baseDelivery),
      },
      {
        brief_id: body.briefId,
        type: "status-transitioned",
        actor: auth.actor,
        payload: { from: prev.status, to: "ready-for-agent" },
        idempotency_key: deriveIdempotencyKey(
          body.briefId,
          "status-transitioned",
          auth.actor,
          baseDelivery,
        ),
      },
    ]);

    return jsonResponse({ briefId: body.briefId, status: "ready-for-agent" });
  } catch (err) {
    console.error("[major-rearm-brief]", err);
    return errorResponse("Internal server error", 500);
  }
});
