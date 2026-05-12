// supabase/functions/major-start-auto-triage/index.ts
//
// POST /major-start-auto-triage
//   body: { briefId: number, notes?: string }
//   200:  { requestId: number, status: 'requested' }
//   409:  if a non-terminal request already exists for this Brief
//
// Creates an Auto Triage Request row. The request will be picked up by the
// Auto Triage worker (TODO — not implemented in this slice; lives in the
// Shell's triage path). The DB enforces "at most one non-terminal request
// per Brief" via a partial unique index.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface StartBody {
  briefId: number;
  notes?: string;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as StartBody;
    if (!body?.briefId) {
      return errorResponse("Invalid body — expected { briefId }", 400);
    }

    // Snapshot the current revision so the auto-triage Run runs against a stable PRD.
    const { data: brief, error: fetchErr } = await auth.client
      .from("briefs")
      .select("id, current_revision_id")
      .eq("id", body.briefId)
      .single();
    if (fetchErr || !brief) return errorResponse("Brief not found", 404);

    const { data, error } = await auth.client
      .from("auto_triage_requests")
      .insert({
        brief_id: body.briefId,
        status: "requested",
        requested_actor: auth.actor,
        requested_revision_id: brief.current_revision_id ?? null,
        notes: body.notes ?? null,
      })
      .select("id, status")
      .single();

    if (error) {
      // The partial unique index throws 23505 if a non-terminal request
      // already exists for this Brief.
      if ((error as any).code === "23505") {
        return errorResponse("A non-terminal auto-triage request already exists for this brief", 409);
      }
      console.error("[major-start-auto-triage] insert failed:", error);
      return errorResponse("Internal server error", 500);
    }

    // TODO: enqueue work for the auto-triage worker / Shell. Once the
    // Shell's triage entry-point is wired (purpose='triage' Run started by
    // the Shell's `runTriage` function), this becomes the trigger point.

    return jsonResponse({ requestId: data.id, status: data.status });
  } catch (err) {
    console.error("[major-start-auto-triage]", err);
    return errorResponse("Internal server error", 500);
  }
});
