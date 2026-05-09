// supabase/functions/major-claim-item/index.ts
//
// POST /major-claim-item
//   body: {
//     runnerId: string,        // 'runner-A','runner-B'…
//     itemId?: number,         // optional — claim a specific item
//     leaseMinutes?: number,   // default 5
//     purpose?: 'execute'|'review'|'triage'|'repair'   // default 'execute'
//   }
//   200: { claimed: true, item: WorkItem, run: Run, revisionId: number|null }
//   409: { claimed: false }   — nothing eligible / lost the race
//
// Implements the Run Start Transaction. Delegates to the
// `major.claim_next_item` RPC, which atomically:
//   1. SELECTs the highest-priority Runner-Eligible Item with FOR UPDATE
//      SKIP LOCKED (so concurrent runners never collide).
//   2. UPDATEs status → agent-running.
//   3. INSERTs a `runs` row in 'running' state with lease + heartbeat.
//   4. INSERTs `run-started` and `status-transitioned` Events.
// Single Active Run Rule is enforced by the partial unique index on
// `runs(work_item_id) where outcome='running'` — no two simultaneous Runs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface ClaimBody {
  runnerId: string;
  itemId?: number;
  leaseMinutes?: number;
  purpose?: "execute" | "review" | "triage" | "repair";
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as ClaimBody;
    if (!body?.runnerId || typeof body.runnerId !== "string") {
      return errorResponse("Invalid body — expected { runnerId }", 400);
    }
    const lease = body.leaseMinutes && body.leaseMinutes > 0 ? body.leaseMinutes : 5;
    const purpose = body.purpose ?? "execute";

    // Idempotency: a run that retries this call (e.g., timeout from runner
    // side) should produce a deterministic key inside the RPC. We seed with
    // the runner id + a request-scoped UUID; replays with the same id are no-ops.
    const idem = deriveIdempotencyKey(
      body.itemId ?? null,
      "claim-attempt",
      `runner:${body.runnerId}`,
      crypto.randomUUID(),
    );

    // Make sure the runner row exists. The RPC has a FK on runner_id.
    await auth.client
      .from("runner_instances")
      .upsert({ id: body.runnerId, heartbeat_at: new Date().toISOString() }, { onConflict: "id" });

    const { data, error } = await auth.client.rpc("claim_next_item", {
      p_runner_id: body.runnerId,
      p_specific_item_id: body.itemId ?? null,
      p_lease_minutes: lease,
      p_purpose: purpose,
      p_idempotency_key: idem,
    });

    if (error) {
      console.error("[major-claim-item] RPC failed:", error);
      return errorResponse(error.message, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.item_id == null) {
      return jsonResponse({ claimed: false }, 409);
    }

    // Hydrate the resulting Item + Run for the runner so it can start work
    // without an extra round trip.
    const [{ data: item }, { data: run }] = await Promise.all([
      auth.client.from("work_items").select("*").eq("id", row.item_id).single(),
      auth.client.from("runs").select("*").eq("id", row.run_id).single(),
    ]);

    return jsonResponse({
      claimed: true,
      item,
      run,
      revisionId: row.revision_id ?? null,
    });
  } catch (err) {
    console.error("[major-claim-item]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
