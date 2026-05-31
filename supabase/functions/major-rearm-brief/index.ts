// supabase/functions/major-rearm-brief/index.ts
//
// POST /major-rearm-brief
//   body: { briefId: number, reason?: string, mode?: "repair-override" }
//
// Standard re-arm: { briefId, reason? }
//   200:  { briefId, status: 'ready-for-agent' }
//   Transitions a Brief from `ready-for-human` back to `ready-for-agent`.
//   Records `rearmed` and `status-transitioned` Events.
//
// Repair-override: { briefId, mode: "repair-override" }
//   200:  { ok: true }
//   Requires brief.status === 'ready-for-human' AND latest run outcome === 'failed'.
//   Sets status to 'ready-for-agent' and next_claim_purpose to 'repair' so the
//   next claim picks a repair Run irrespective of retry budget (ADR 014).
//   Records `human-rearm` and `status-transitioned` Events with mode in payload.
//
//   NOTE: next_claim_purpose requires a companion migration (sub-Brief of #103).
//   The UPDATE below will fail at runtime until that migration is applied.
//
// Only `ready-for-human → ready-for-agent` is allowed. Re-arming from a
// terminal status (`done`, `wontfix`) is rejected with 409.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate, type MajorClient } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface RearmBody {
  briefId: number;
  reason?: string;
  mode?: "repair-override";
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
      return errorResponse("Invalid body — expected { briefId, reason?, mode? }", 400);
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

    if (body.mode === "repair-override") {
      return await applyRepairOverride(auth.client, auth.actor, body.briefId, prev.status);
    }

    return await applyStandardRearm(auth.client, auth.actor, body.briefId, prev.status, body.reason);
  } catch (err) {
    console.error("[major-rearm-brief]", err);
    return errorResponse("Internal server error", 500);
  }
});

async function applyStandardRearm(
  client: MajorClient,
  actor: string,
  briefId: number,
  prevStatus: string,
  reason?: string,
) {
  // Atomic status flip — absorbs the race where two operators click Re-arm
  // simultaneously. Affects 0 rows on race; surfaced as 409.
  const { data: updated, error: updErr } = await client
    .from("briefs")
    .update({ status: "ready-for-agent" })
    .eq("id", briefId)
    .eq("status", "ready-for-human")
    .select("id");
  if (updErr) {
    console.error("[major-rearm-brief] update failed:", updErr);
    return errorResponse("Internal server error", 500);
  }
  if (!updated || updated.length === 0) {
    return errorResponse("Brief status changed concurrently; refresh and retry", 409);
  }

  const reasonText = typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "re-armed via UI";
  const baseDelivery = `rearm-${briefId}-${Date.now()}`;
  await client.from("events").insert([
    {
      brief_id: briefId,
      type: "rearmed",
      actor,
      payload: { reason: reasonText, prev_status: prevStatus },
      idempotency_key: deriveIdempotencyKey(briefId, "rearmed", actor, baseDelivery),
    },
    {
      brief_id: briefId,
      type: "status-transitioned",
      actor,
      payload: { from: prevStatus, to: "ready-for-agent" },
      idempotency_key: deriveIdempotencyKey(briefId, "status-transitioned", actor, baseDelivery),
    },
  ]);

  return jsonResponse({ briefId, status: "ready-for-agent" });
}

async function applyRepairOverride(
  client: MajorClient,
  actor: string,
  briefId: number,
  prevStatus: string,
) {
  // Require the latest run to be failed — repair-override is for targeted repair
  // of a known failure, not a general retry.
  const { data: latestRun, error: runErr } = await client
    .from("runs")
    .select("id, outcome")
    .eq("brief_id", briefId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runErr) {
    console.error("[major-rearm-brief] run fetch failed:", runErr);
    return errorResponse("Internal server error", 500);
  }
  if (!latestRun || latestRun.outcome !== "failed") {
    return errorResponse(
      "Re-arm as Repair requires the latest run to have outcome 'failed'",
      409,
    );
  }

  // NOTE: next_claim_purpose column requires a companion migration (sub-Brief of #103).
  // This UPDATE will fail at runtime with a Postgres unknown-column error until that
  // migration is applied. The column is included here to document the contract — when
  // the migration lands, no code change is needed in this function.
  const { data: updated, error: updErr } = await client
    .from("briefs")
    .update({ status: "ready-for-agent", next_claim_purpose: "repair" })
    .eq("id", briefId)
    .eq("status", "ready-for-human")
    .select("id");

  if (updErr) {
    console.error("[major-rearm-brief] repair-override update failed:", updErr);
    return errorResponse("Internal server error", 500);
  }
  if (!updated || updated.length === 0) {
    return errorResponse("Brief status changed concurrently; refresh and retry", 409);
  }

  const baseDelivery = `repair-rearm-${briefId}-${Date.now()}`;
  await client.from("events").insert([
    {
      brief_id: briefId,
      type: "human-rearm",
      actor,
      payload: { mode: "repair-override", prev_status: prevStatus },
      idempotency_key: deriveIdempotencyKey(briefId, "human-rearm", actor, baseDelivery),
    },
    {
      brief_id: briefId,
      type: "status-transitioned",
      actor,
      payload: { from: prevStatus, to: "ready-for-agent" },
      idempotency_key: deriveIdempotencyKey(briefId, "status-transitioned", actor, baseDelivery),
    },
  ]);

  return jsonResponse({ ok: true });
}
