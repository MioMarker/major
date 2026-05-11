// supabase/functions/major-finalize-triage-session/index.ts
//
// POST /major-finalize-triage-session
//   body: {
//     sessionId: number,
//     summary?: string,
//     operations: Array<ChangeOp>
//   }
//   200:  { changeSetId, needsHumanApply, blockerReasons, appliedOpCount }
//
// ChangeOp shape:
//   {
//     operation_type: 'create-brief' | 'add-content-revision' | ...,
//     payload: object,                  // operation-specific (see supabase/migrations/20260509000001_rpc_functions.sql)
//     sequence_index: integer
//   }
//
// Pipeline:
//   1. Insert a `triage_change_sets` row tied to this session.
//   2. Insert one `triage_change_operations` row per op with derived idem keys.
//   3. Run the path-blocker rule against (a) every `expected_paths` mentioned
//      in `create-brief` / transition-to-ready ops and (b) the rerank-op count.
//   4. If `needsHumanApply=true` → mark the change set, return it for the UI
//      to surface in the Pending QA queue with a "needs human apply" badge.
//      If false → call `major.apply_change_set` RPC which atomically applies
//      every op in sequence within a single Postgres transaction.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { checkPathBlocker } from "../_shared/path_blocker.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface ChangeOp {
  operation_type: string;
  payload: Record<string, unknown>;
  sequence_index: number;
}

interface FinalizeBody {
  sessionId: number;
  summary?: string;
  operations: ChangeOp[];
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as FinalizeBody;
    if (!body?.sessionId || !Array.isArray(body.operations)) {
      return errorResponse("Invalid body — expected { sessionId, operations: [...] }", 400);
    }

    // Validate each op carries the required shape — the schema check
    // constraint covers `operation_type`, but we also need a payload object
    // and a numeric `sequence_index` to insert.
    for (const op of body.operations) {
      if (!op.operation_type || typeof op.payload !== "object" || typeof op.sequence_index !== "number") {
        return errorResponse(`Invalid op: ${JSON.stringify(op)}`, 400);
      }
    }

    // Empty-operations fast path: the triage Tachikoma isn't wired yet; the UI
    // sends operations:[] as a stub so sessions can be closed without proposals.
    if (body.operations.length === 0) {
      const { data: emptySet, error: emptyErr } = await auth.client
        .from("triage_change_sets")
        .insert({
          triage_session_id: body.sessionId,
          decision: "proposed",
          summary: body.summary ?? null,
          needs_human_apply: false,
          blocker_reasons: [],
        })
        .select("id, needs_human_apply, blocker_reasons")
        .single();
      if (emptyErr || !emptySet) {
        return errorResponse(emptyErr?.message ?? "change set insert failed", 500);
      }
      await auth.client
        .from("triage_sessions")
        .update({ status: "closed" })
        .eq("id", body.sessionId);
      return jsonResponse({
        changeSetId: emptySet.id,
        needsHumanApply: false,
        blockerReasons: [],
        appliedOpCount: 0,
      });
    }

    // Load the path-blocker config (singleton row id=1).
    const { data: cfg, error: cfgErr } = await auth.client
      .from("path_blocker_config")
      .select("protected_globs, mass_rerank_threshold")
      .eq("id", 1)
      .single();

    if (cfgErr || !cfg) {
      return errorResponse("path_blocker_config missing", 500);
    }

    // Aggregate `expected_paths` across create-brief + transition-to-ready ops,
    // and count rerank ops for the mass-rerank threshold check.
    const expectedPaths: string[] = [];
    let rerankOpCount = 0;
    for (const op of body.operations) {
      if (op.operation_type === "create-brief") {
        const paths = (op.payload?.expected_paths ?? []) as unknown;
        if (Array.isArray(paths)) expectedPaths.push(...paths.filter((p): p is string => typeof p === "string"));
      }
      if (op.operation_type === "transition-brief" && op.payload?.to_status === "ready-for-agent") {
        const paths = (op.payload?.expected_paths ?? []) as unknown;
        if (Array.isArray(paths)) expectedPaths.push(...paths.filter((p): p is string => typeof p === "string"));
      }
      if (op.operation_type === "set-queue-rank") rerankOpCount++;
    }

    const blocker = checkPathBlocker(expectedPaths, rerankOpCount, {
      protectedGlobs: cfg.protected_globs,
      massRerankThreshold: cfg.mass_rerank_threshold,
    });

    // Insert the Change Set row.
    const { data: changeSet, error: setErr } = await auth.client
      .from("triage_change_sets")
      .insert({
        triage_session_id: body.sessionId,
        decision: "proposed",
        summary: body.summary ?? null,
        needs_human_apply: blocker.needsHumanApply,
        blocker_reasons: blocker.reasons,
      })
      .select("id, needs_human_apply, blocker_reasons")
      .single();

    if (setErr || !changeSet) {
      console.error("[major-finalize-triage-session] change set insert failed:", setErr);
      return errorResponse(setErr?.message ?? "change set insert failed", 500);
    }

    // Insert each op with derived idempotency key.
    const opRows = body.operations.map((op) => ({
      change_set_id: changeSet.id,
      operation_type: op.operation_type,
      payload: op.payload,
      sequence_index: op.sequence_index,
      status: "proposed",
      idempotency_key: deriveIdempotencyKey(
        null,
        `change-op:${op.operation_type}`,
        auth.actor,
        `cs-${changeSet.id}-seq-${op.sequence_index}`,
      ),
    }));

    const { error: opsErr } = await auth.client
      .from("triage_change_operations")
      .insert(opRows);

    if (opsErr) {
      console.error("[major-finalize-triage-session] op insert failed:", opsErr);
      return errorResponse(opsErr.message, 500);
    }

    // Close the session — the conversation is settled, this Change Set is its outcome.
    await auth.client
      .from("triage_sessions")
      .update({ status: "closed" })
      .eq("id", body.sessionId);

    if (blocker.needsHumanApply) {
      // Sit in the queue for human apply via major-apply-change-set.
      return jsonResponse({
        changeSetId: changeSet.id,
        needsHumanApply: true,
        blockerReasons: blocker.reasons,
        appliedOpCount: 0,
      });
    }

    // Path-blocker passed — apply ops atomically via the RPC.
    const { data: applied, error: applyErr } = await auth.client.rpc("apply_change_set", {
      p_change_set_id: changeSet.id,
      p_actor: auth.actor,
      p_idempotency_root: `finalize-${changeSet.id}`,
    });

    if (applyErr) {
      console.error("[major-finalize-triage-session] apply RPC failed:", applyErr);
      return errorResponse(applyErr.message, 500);
    }

    const result = Array.isArray(applied) ? applied[0] : applied;
    return jsonResponse({
      changeSetId: changeSet.id,
      needsHumanApply: false,
      blockerReasons: [],
      appliedOpCount: result?.applied_op_count ?? 0,
    });
  } catch (err) {
    console.error("[major-finalize-triage-session]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
