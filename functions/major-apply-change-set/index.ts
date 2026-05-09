// functions/major-apply-change-set/index.ts
//
// POST /major-apply-change-set
//   body: { changeSetId: number }
//   200:  { appliedOpCount: number }
//
// Manually applies a queued (needs-human-apply) Change Set. Calls the
// `major.apply_change_set` RPC, which runs every operation in
// sequence_index order inside a single Postgres transaction. Stop-on-
// failure: any op that throws rolls the entire apply back, so the change
// set state remains `proposed` and the human can edit & retry.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface ApplyBody {
  changeSetId: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as ApplyBody;
    if (!body?.changeSetId) {
      return errorResponse("Invalid body — expected { changeSetId }", 400);
    }

    // Sanity check the change set exists and is still proposed.
    const { data: cs, error: lookupErr } = await auth.client
      .from("triage_change_sets")
      .select("id, decision")
      .eq("id", body.changeSetId)
      .single();

    if (lookupErr || !cs) {
      return errorResponse(lookupErr?.message ?? "change set not found", 404);
    }
    if (cs.decision !== "proposed") {
      return errorResponse(`Change set already ${cs.decision}`, 409);
    }

    const { data: applied, error: applyErr } = await auth.client.rpc("apply_change_set", {
      p_change_set_id: body.changeSetId,
      p_actor: auth.actor,
      p_idempotency_root: `manual-apply-${body.changeSetId}`,
    });

    if (applyErr) {
      console.error("[major-apply-change-set] RPC failed:", applyErr);
      return errorResponse(applyErr.message, 500);
    }

    const result = Array.isArray(applied) ? applied[0] : applied;
    return jsonResponse({ appliedOpCount: result?.applied_op_count ?? 0 });
  } catch (err) {
    console.error("[major-apply-change-set]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
