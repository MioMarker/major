// supabase/functions/major-record-telemetry/index.ts
//
// POST /major-record-telemetry
//   body: {
//     run_id:           number,
//     observation_type: string,
//     payload:          Record<string, unknown>,
//     idempotency_key:  string,
//   }
//   200: { record: TelemetryRecord }         — newly written or existing (dedup)
//   400: { error: string }                   — schema validation failure
//   401: { error: string }                   — auth failure
//   500: { error: string }                   — server error
//
// Called by the Shell (main.ts finalizeRun telemetry path) and the Tachikoma's
// Bash PreToolUse hook (sandbox-pretooluse-bash.sh) to record Telemetry Records.
//
// TelemetryWriter performs the atomic write:
//   1. Sanitize + truncate every string value in `payload`.
//   2. Call the `record_telemetry_observation` RPC, which in one transaction:
//      a. Checks idempotency_key for duplicates (returns existing row if found).
//      b. Increments runs.tachikoma_event_sequence.
//      c. Inserts the Telemetry Record.
//
// Auth: service-role bypass (Shell calls; hook calls). No JWT user in the loop.
// verify_jwt is false in supabase/config.toml; auth.ts handles the service-role
// path via the Authorization header + X-Major-Shell-Id.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { jsonResponse, errorResponse } from "../_shared/response.ts";
import { sanitizeRecord } from "../_shared/sanitizer.ts";
import type { MajorClient } from "../_shared/auth.ts";

// ────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────

const RecordTelemetryRequest = z.object({
  run_id: z.number().int().positive(),
  observation_type: z.string().min(1).max(120),
  payload: z.record(z.unknown()),
  idempotency_key: z.string().min(1).max(512),
});

type RecordTelemetryRequest = z.infer<typeof RecordTelemetryRequest>;

// ────────────────────────────────────────────────────────────────────
// TelemetryWriter
// ────────────────────────────────────────────────────────────────────

export interface TelemetryWriteResult {
  record: Record<string, unknown>;
}

/**
 * Atomically write one Telemetry Record via the `record_telemetry_observation`
 * RPC. Sanitizes and truncates string fields in `payload` before the RPC call
 * so that no secret or oversized value is ever persisted.
 *
 * Returns the written row, or the existing row when the idempotency_key is a
 * duplicate (the RPC is a no-op and returns the original record).
 */
export async function telemetryWriter(
  client: MajorClient,
  req: RecordTelemetryRequest,
): Promise<TelemetryWriteResult> {
  const sanitizedPayload = sanitizeRecord(req.payload);

  const { data, error } = await client.rpc("record_telemetry_observation", {
    p_run_id: req.run_id,
    p_observation_type: req.observation_type,
    p_payload: sanitizedPayload,
    p_idempotency_key: req.idempotency_key,
  });

  if (error) {
    throw new Error(`record_telemetry_observation RPC failed: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    throw new Error("record_telemetry_observation returned no rows");
  }

  const record = rows[0] as Record<string, unknown>;

  return { record };
}

// ────────────────────────────────────────────────────────────────────
// Edge function handler
// ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = RecordTelemetryRequest.safeParse(await req.json());
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400);
    }

    const result = await telemetryWriter(auth.client, parsed.data);
    return jsonResponse({ record: result.record });
  } catch (err) {
    console.error("[MajorRecordTelemetry]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
