// supabase/functions/major-delete-brief/index.ts
//
// POST /major-delete-brief
//   body: { briefId: number }
//   200:  { briefId, deleted: true }
//
// Permanently deletes a Brief and all cascade-linked records (revisions,
// runs, artifacts, events, relationships). Blocked when status='agent-running'.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface DeleteBriefBody {
  briefId: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as DeleteBriefBody;
    if (!body?.briefId || typeof body.briefId !== "number") {
      return errorResponse("Invalid body — expected { briefId }", 400);
    }

    const { data: brief, error: fetchErr } = await auth.client
      .from("briefs")
      .select("id, status")
      .eq("id", body.briefId)
      .single();
    if (fetchErr || !brief) return errorResponse("Brief not found", 404);
    if (brief.status === "agent-running") {
      return errorResponse("Cannot delete a brief while an agent is running on it", 409);
    }

    const { error: delErr } = await auth.client
      .from("briefs")
      .delete()
      .eq("id", body.briefId);
    if (delErr) {
      console.error("[MajorDeleteBrief] delete failed:", delErr);
      return errorResponse("Internal server error", 500);
    }

    return jsonResponse({ briefId: body.briefId, deleted: true });
  } catch (err) {
    console.error("[MajorDeleteBrief]", err);
    return errorResponse("Internal server error", 500);
  }
});
