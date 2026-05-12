// supabase/functions/major-delete-triage-session/index.ts
//
// POST /major-delete-triage-session
//   body: { sessionId: number }
//   200:  { sessionId, deleted: true }
//
// Permanently deletes a Triage Session. Before deletion:
//   1. Deletes associated change sets (operations cascade from change sets).
//   2. Nullifies source_session_id on any briefs created from this session
//      so those briefs remain intact as independent work items.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface DeleteSessionBody {
  sessionId: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as DeleteSessionBody;
    if (!body?.sessionId || typeof body.sessionId !== "number") {
      return errorResponse("Invalid body — expected { sessionId }", 400);
    }

    const { error: fetchErr } = await auth.client
      .from("triage_sessions")
      .select("id")
      .eq("id", body.sessionId)
      .single();
    if (fetchErr) return errorResponse("Session not found", 404);

    // Delete change sets first (operations cascade from change sets via FK).
    const { error: csErr } = await auth.client
      .from("triage_change_sets")
      .delete()
      .eq("triage_session_id", body.sessionId);
    if (csErr) {
      console.error("[MajorDeleteTriageSession] change set delete failed:", csErr);
      return errorResponse("Internal server error", 500);
    }

    // Nullify source_session_id on briefs that were created from this session.
    const { error: briefErr } = await auth.client
      .from("briefs")
      .update({ source_session_id: null })
      .eq("source_session_id", body.sessionId);
    if (briefErr) {
      console.error("[MajorDeleteTriageSession] brief nullify failed:", briefErr);
      return errorResponse("Internal server error", 500);
    }

    const { error: delErr } = await auth.client
      .from("triage_sessions")
      .delete()
      .eq("id", body.sessionId);
    if (delErr) {
      console.error("[MajorDeleteTriageSession] delete failed:", delErr);
      return errorResponse("Internal server error", 500);
    }

    return jsonResponse({ sessionId: body.sessionId, deleted: true });
  } catch (err) {
    console.error("[MajorDeleteTriageSession]", err);
    return errorResponse("Internal server error", 500);
  }
});
