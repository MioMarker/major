// supabase/functions/major-create-triage-session/index.ts
//
// POST /major-create-triage-session
//   body: {} (none required; initiator inferred from auth)
//   200:  { id: number, status: 'open', created_at: string }
//
// Opens a new Triage Session row. The transcript starts empty and the draft
// PRD is null; both grow over the session via major-send-triage-message.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const { data, error } = await auth.client
      .from("triage_sessions")
      .insert({
        initiator_actor: auth.actor,
        status: "open",
        transcript: [],
      })
      .select("id, status, created_at")
      .single();

    if (error) {
      console.error("[major-create-triage-session] insert failed:", error);
      return errorResponse(error.message, 500);
    }
    return jsonResponse(data);
  } catch (err) {
    console.error("[major-create-triage-session]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
