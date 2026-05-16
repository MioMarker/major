// supabase/functions/major-get-triage-session/index.ts
//
// GET /major-get-triage-session?id=<bigint>
//   200: TriageSession
//   404: { error: 'Not found' }
//
// Fetches a single Triage Session row by id. Used by /triage/[sessionId]
// to render the session detail page.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const url = new URL(req.url);
    const idParam = url.searchParams.get("id");
    const id = Number(idParam);
    if (!idParam || !Number.isInteger(id) || id <= 0) {
      return errorResponse("Query param 'id' must be a positive integer", 400);
    }

    const { data, error } = await auth.client
      .from("triage_sessions")
      .select(
        "id, initiator_actor, status, transcript, draft_prd, entry_point, trigger_payload, created_at, updated_at",
      )
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[major-get-triage-session] select failed:", error);
      return errorResponse("Internal server error", 500);
    }
    if (!data) {
      return errorResponse("Not found", 404);
    }

    return jsonResponse(data);
  } catch (err) {
    console.error("[major-get-triage-session]", err);
    return errorResponse("Internal server error", 500);
  }
});
