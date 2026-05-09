// supabase/functions/major-heartbeat/index.ts
//
// POST /major-heartbeat
//   body: { shellId: string, runId?: number }
//   200: { renewedRun: boolean, leaseExpiresAt: string|null }
//
// The Shell posts this every ~30 seconds. It refreshes:
//   - The Shell row's `heartbeat_at` (table is `runner_instances` until Phase 3
//     renames it to `shells`).
//   - When `runId` is provided AND that run is still 'running' AND owned by
//     this Shell: `runs.heartbeat_at` and `runs.lease_expires_at = now() + 5 min`.
//
// If the run is not owned by the calling Shell or is no longer running
// (e.g., reaper already cancelled it), `renewedRun=false` is returned and
// the Shell should treat the work as forfeited and abort gracefully.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface HeartbeatBody {
  shellId: string;
  runId?: number;
  leaseMinutes?: number;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as HeartbeatBody;
    if (!body?.shellId) {
      return errorResponse("Invalid body — expected { shellId }", 400);
    }
    const lease = body.leaseMinutes && body.leaseMinutes > 0 ? body.leaseMinutes : 5;
    const now = new Date();

    const upsertResult = await auth.client
      .from("runner_instances")
      .upsert({ id: body.shellId, heartbeat_at: now.toISOString() }, { onConflict: "id" })
      .select();

    if (upsertResult.error) {
      console.error("[major-heartbeat] runner_instances upsert error:", upsertResult.error);
      return errorResponse(`upsert failed: ${upsertResult.error.message} (code=${upsertResult.error.code ?? "?"})`, 500);
    }
    console.log("[major-heartbeat] upserted shell row:", upsertResult.data?.length ?? 0, "rows");

    if (!body.runId) {
      return jsonResponse({ renewedRun: false, leaseExpiresAt: null });
    }

    const expiresAt = new Date(now.getTime() + lease * 60_000).toISOString();
    const { data, error } = await auth.client
      .from("runs")
      .update({ heartbeat_at: now.toISOString(), lease_expires_at: expiresAt })
      .eq("id", body.runId)
      .eq("runner_id", body.shellId)
      .eq("outcome", "running")
      .select("id, lease_expires_at")
      .maybeSingle();

    if (error) {
      console.error("[major-heartbeat] update failed:", error);
      return errorResponse(error.message, 500);
    }
    if (!data) {
      return jsonResponse({ renewedRun: false, leaseExpiresAt: null });
    }
    return jsonResponse({ renewedRun: true, leaseExpiresAt: data.lease_expires_at });
  } catch (err) {
    console.error("[major-heartbeat]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
