// supabase/functions/major-reaper/index.ts
//
// POST /major-reaper
//   body: {} (none)
//   200:  { cancelledRuns: number, briefsReturned: number }
//
// Lease-Expiry Reaper. Called on a 60-second schedule by pg_cron (see
// README for setup) — no Supabase Auth required. The function must be
// deployed with `verify_jwt = false`.
//
// Delegates to `major.reaper_sweep` which atomically:
//   1. SELECT runs WHERE outcome='running' AND lease_expires_at < now()
//   2. For each:
//      - UPDATE runs SET outcome='cancelled', cancellation_reason='lease-expired'
//      - UPDATE briefs SET status='ready-for-agent' (clean retry)
//      - INSERT events: run-ended, status-transitioned
//      - INSERT telemetry_records: 'repair-inspection-trigger'

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { getAdminClient } from "../_shared/db.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  // Allow GET as a manual liveness/poke from a developer terminal.
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const client = getAdminClient();
    const { data, error } = await client.rpc("reaper_sweep");
    if (error) {
      console.error("[major-reaper] sweep failed:", error);
      return errorResponse("Internal server error", 500);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return jsonResponse({
      cancelledRuns: row?.cancelled_runs ?? 0,
      briefsReturned: row?.briefs_returned ?? 0,
    });
  } catch (err) {
    console.error("[major-reaper]", err);
    return errorResponse("Internal server error", 500);
  }
});
