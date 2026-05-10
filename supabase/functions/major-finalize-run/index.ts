// supabase/functions/major-finalize-run/index.ts
//
// POST /major-finalize-run
//   body: {
//     runId: number,
//     outcome: 'succeeded' | 'failed' | 'cancelled',
//     nextStatus: BriefStatus,
//     handoffReason?: string,           // required when nextStatus='ready-for-human'
//     cancellationReason?: string,      // 'human-cancellation','system-cancellation','lease-expired','repair-acquisition'
//     verificationResults?: Array<{
//       check_name: string,             // 'tsc-noemit','tests','eval-gate','reviewer-tachikoma'
//       outcome: 'pass'|'fail'|'skipped',
//       required: boolean,
//       requiredness_source?: string,
//       payload?: object
//     }>,
//     artifacts?: Array<{
//       artifact_type: 'git-change'|'triage-change-set',
//       external_ref?: string,          // PR URL / change set id
//       payload?: object
//     }>,
//     tachikomaCompletion?: object,     // stream-json 'result' event body (ADR 006 Slice 4)
//     actor?: string                    // override; defaults to authenticated user actor
//   }
//   200: { briefId, runId }
//
// Implements the Run Finalization Transaction. Delegates to the
// `major.finalize_run` RPC which atomically:
//   1. UPDATE runs SET outcome, ended_at, cancellation_reason, [summary metrics]
//   2. INSERT verification_results (one per check_name)
//   3. INSERT brief_artifacts
//   4. UPDATE briefs SET status = nextStatus
//   5. INSERT events: run-ended, status-transitioned, [human-handoff]

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";
import { RunSummaryHoist } from "./run-summary-hoist.ts";

// ────────────────────────────────────────────────────────────────────
// Schemas
// ────────────────────────────────────────────────────────────────────

// Validates the optional stream-json completion event body. All fields are
// optional — the format may evolve and we only extract what we know.
const TachikomaCompletionSchema = z.object({
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  result: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

// ────────────────────────────────────────────────────────────────────
// Body types
// ────────────────────────────────────────────────────────────────────

interface VerificationInput {
  check_name: string;
  outcome: "pass" | "fail" | "skipped";
  required?: boolean;
  requiredness_source?: string;
  payload?: Record<string, unknown>;
}

interface ArtifactInput {
  artifact_type: "git-change" | "triage-change-set";
  external_ref?: string;
  payload?: Record<string, unknown>;
}

interface FinalizeBody {
  runId: number;
  outcome: "succeeded" | "failed" | "cancelled";
  nextStatus: string;
  handoffReason?: string;
  cancellationReason?: string;
  verificationResults?: VerificationInput[];
  artifacts?: ArtifactInput[];
  /** stream-json 'result' event body; when present, hoisted into runs summary columns. */
  tachikomaCompletion?: Record<string, unknown>;
  actor?: string;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const ALLOWED_NEXT_STATUSES = new Set([
  "ready-for-review",
  "ready-for-human",
  "ready-for-agent",
  "wontfix",
  "needs-info",
  "ready-for-triage",
]);

// ────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as FinalizeBody;
    if (!body?.runId || !body.outcome || !body.nextStatus) {
      return errorResponse("Invalid body — expected { runId, outcome, nextStatus }", 400);
    }
    if (!ALLOWED_NEXT_STATUSES.has(body.nextStatus)) {
      return errorResponse(`nextStatus '${body.nextStatus}' not allowed by Run Finalization`, 400);
    }
    if (body.nextStatus === "ready-for-human" && !body.handoffReason) {
      return errorResponse("ready-for-human requires handoffReason", 400);
    }

    // Validate and hoist tachikomaCompletion when present.
    let summaryMetrics: ReturnType<typeof RunSummaryHoist> | null = null;
    if (body.tachikomaCompletion !== undefined) {
      const parsed = TachikomaCompletionSchema.safeParse(body.tachikomaCompletion);
      if (!parsed.success) {
        return errorResponse(`tachikomaCompletion: ${parsed.error.message}`, 400);
      }
      summaryMetrics = RunSummaryHoist(parsed.data);
    }

    const actor = body.actor ?? auth.actor;
    const idem = deriveIdempotencyKey(
      null,
      "run-finalize",
      actor,
      `run-${body.runId}`,
    );

    const { data, error } = await auth.client.rpc("finalize_run", {
      p_run_id: body.runId,
      p_outcome: body.outcome,
      p_next_status: body.nextStatus,
      p_actor: actor,
      p_handoff_reason: body.handoffReason ?? null,
      p_cancellation_reason: body.cancellationReason ?? null,
      p_verification_results: body.verificationResults ?? [],
      p_artifacts: body.artifacts ?? [],
      p_idempotency_key: idem,
      p_num_turns: summaryMetrics?.numTurns ?? null,
      p_duration_ms: summaryMetrics?.durationMs ?? null,
      p_final_text: summaryMetrics?.finalText ?? null,
      p_input_tokens: summaryMetrics?.inputTokens ?? null,
      p_output_tokens: summaryMetrics?.outputTokens ?? null,
      p_cache_read_tokens: summaryMetrics?.cacheReadTokens ?? null,
      p_cache_write_tokens: summaryMetrics?.cacheWriteTokens ?? null,
    });

    if (error) {
      console.error("[major-finalize-run] RPC failed:", error);
      return errorResponse(error.message, 500);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return jsonResponse({ briefId: row?.brief_id ?? null, runId: row?.run_id ?? null });
  } catch (err) {
    console.error("[major-finalize-run]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
