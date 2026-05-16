// supabase/functions/major-get-brief/index.ts
//
// GET /major-get-brief?briefId=<n>
//   200: BriefDetail — i.e. the brief row spread at the top level, plus:
//     current_revision: BriefContentRevision | null,  // resolved from current_revision_id
//     revisions: BriefContentRevision[],              // newest first
//     events: Event[],                                // last 50, newest first
//     runs: Run[],
//     verification_results: VerificationResult[],     // joined under their run
//     artifacts: BriefArtifact[],
//     telemetry_records: TelemetryRecord[],           // last 200, newest first
//     relationships: Array<BriefRelationship & { related_brief: { id, status } }>
//
// Wire shape matches `ui/lib/types.ts:BriefDetail`. PostgREST returns rows in
// snake_case; we keep top-level keys snake_case too so the UI consumes the
// response without a transformation layer.

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
    const briefId = Number(url.searchParams.get("briefId"));
    if (!briefId || Number.isNaN(briefId)) {
      return errorResponse("Missing or invalid briefId", 400);
    }

    const [brief, revisions, events, runs, artifacts, relAsParent, relAsChild] = await Promise.all([
      auth.client.from("briefs").select("*").eq("id", briefId).single(),
      auth.client
        .from("brief_content_revisions")
        .select("id, brief_id, revision_number, content_md, author_actor, reason, created_at")
        .eq("brief_id", briefId)
        .order("revision_number", { ascending: false }),
      auth.client
        .from("events")
        .select("id, brief_id, type, actor, payload, idempotency_key, run_id, created_at")
        .eq("brief_id", briefId)
        .order("created_at", { ascending: false })
        .limit(50),
      auth.client
        .from("runs")
        .select("*")
        .eq("brief_id", briefId)
        .order("started_at", { ascending: false }),
      auth.client.from("brief_artifacts").select("*").eq("brief_id", briefId),
      auth.client
        .from("brief_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, excluded_by_actor, created_at")
        .eq("parent_id", briefId),
      auth.client
        .from("brief_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, excluded_by_actor, created_at")
        .eq("child_id", briefId),
    ]);

    if (brief.error || !brief.data) {
      return errorResponse("Brief not found", 404);
    }

    // Verification results + telemetry records scoped to this Brief's runs.
    const runIds = (runs.data ?? []).map((r) => r.id);
    let verificationResults: unknown[] = [];
    let telemetryRecords: unknown[] = [];
    if (runIds.length > 0) {
      const [vrResp, trResp] = await Promise.all([
        auth.client.from("verification_results").select("*").in("run_id", runIds),
        auth.client
          .from("telemetry_records")
          .select("*")
          .in("run_id", runIds)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      if (vrResp.error) {
        console.error("[major-get-brief] verification fetch failed:", vrResp.error);
      } else {
        verificationResults = vrResp.data ?? [];
      }
      if (trResp.error) {
        console.error("[major-get-brief] telemetry fetch failed:", trResp.error);
      } else {
        telemetryRecords = trResp.data ?? [];
      }
    }

    // Build the flat relationships array with related_brief joined. From this
    // brief's POV, the related brief is the OTHER side: child for asParent
    // rows, parent for asChild rows.
    const asParentRows = relAsParent.data ?? [];
    const asChildRows = relAsChild.data ?? [];
    const relatedBriefIds = Array.from(
      new Set([
        ...asParentRows.map((r) => r.child_id),
        ...asChildRows.map((r) => r.parent_id),
      ]),
    );
    const relatedBriefById = new Map<number, { id: number; status: string }>();
    if (relatedBriefIds.length > 0) {
      const { data: relatedBriefs, error: rbErr } = await auth.client
        .from("briefs")
        .select("id, status")
        .in("id", relatedBriefIds);
      if (rbErr) {
        console.error("[major-get-brief] related-brief fetch failed:", rbErr);
      } else {
        for (const rb of relatedBriefs ?? []) {
          relatedBriefById.set(rb.id, { id: rb.id, status: rb.status });
        }
      }
    }
    const relationships = [
      ...asParentRows.map((r) => ({
        ...r,
        related_brief: relatedBriefById.get(r.child_id) ?? { id: r.child_id, status: "unknown" },
      })),
      ...asChildRows.map((r) => ({
        ...r,
        related_brief: relatedBriefById.get(r.parent_id) ?? { id: r.parent_id, status: "unknown" },
      })),
    ];

    const revisionRows = revisions.data ?? [];
    const currentRevision =
      revisionRows.find((r) => r.id === brief.data.current_revision_id) ?? null;

    return jsonResponse({
      ...brief.data,
      current_revision: currentRevision,
      revisions: revisionRows,
      events: events.data ?? [],
      runs: runs.data ?? [],
      verification_results: verificationResults,
      artifacts: artifacts.data ?? [],
      telemetry_records: telemetryRecords,
      relationships,
    });
  } catch (err) {
    console.error("[major-get-brief]", err);
    return errorResponse("Internal server error", 500);
  }
});
