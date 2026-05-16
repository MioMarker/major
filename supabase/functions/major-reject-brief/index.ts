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
    .select("id, status")
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

  return jsonResponse({ briefId, status: "wontfix" });
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
