// supabase/functions/major-heartbeat/index.ts
//
// POST /major-heartbeat
//   body: { runnerId: string, runId?: number }
//   200: { renewedRun: boolean, leaseExpiresAt: string|null }
//
// The runner posts this every ~30 seconds. It refreshes:
//   - `runner_instances.heartbeat_at` for the runner row.
//   - When `runId` is provided AND that run is still 'running' AND owned by
//     this runner: `runs.heartbeat_at` and `runs.lease_expires_at = now() + 5 min`.
//
// If the run is not owned by the calling runner or is no longer running
// (e.g., reaper already cancelled it), `renewedRun=false` is returned and
// the runner should treat the work as forfeited and abort gracefully.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface HeartbeatBody {
  runnerId: string;
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
    if (!body?.runnerId) {
      return errorResponse("Invalid body — expected { runnerId }", 400);
    }
    const lease = body.leaseMinutes && body.leaseMinutes > 0 ? body.leaseMinutes : 5;
    const now = new Date();

    await auth.client
      .from("runner_instances")
      .upsert({ id: body.runnerId, heartbeat_at: now.toISOString() }, { onConflict: "id" });

    if (!body.runId) {
      return jsonResponse({ renewedRun: false, leaseExpiresAt: null });
    }

    const expiresAt = new Date(now.getTime() + lease * 60_000).toISOString();
    const { data, error } = await auth.client
      .from("runs")
      .update({ heartbeat_at: now.toISOString(), lease_expires_at: expiresAt })
      .eq("id", body.runId)
      .eq("runner_id", body.runnerId)
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
