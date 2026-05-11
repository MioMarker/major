// supabase/functions/major-list-triage-sessions/index.ts
//
// GET /major-list-triage-sessions?limit=&offset=&status=
//   200: TriageSession[]
//
// Lists Triage Session rows ordered by `updated_at DESC` so the most
// recently active sessions surface first on the /triage list page.
//
// Filters:
//   - status  optional ('open' | 'closed'); omit for both
//   - limit   1-200 (default 50)
//   - offset  0+ (default 0)

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
    const status = url.searchParams.get("status");
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    let query = auth.client
      .from("triage_sessions")
      .select(
        "id, initiator_actor, status, transcript, draft_prd, entry_point, trigger_payload, created_at, updated_at",
      )
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status === "open" || status === "closed") {
      query = query.eq("status", status);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[major-list-triage-sessions] select failed:", error);
      return errorResponse(error.message, 500);
    }

    return jsonResponse(data ?? []);
  } catch (err) {
    console.error("[major-list-triage-sessions]", err);
    return errorResponse(
      err instanceof Error ? err.message : "Server error",
      500,
    );
  }
});

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
