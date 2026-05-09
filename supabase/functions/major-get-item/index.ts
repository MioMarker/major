// supabase/functions/major-get-item/index.ts
//
// GET /major-get-item?briefId=<n>
//   200: {
//     brief: Brief,
//     contentRevisions: BriefContentRevision[],   // newest first
//     events: Event[],                            // last 50, newest first
//     runs: Run[],
//     verificationResults: VerificationResult[],   // joined under their run
//     artifacts: BriefArtifact[],
//     relationships: { asParent: BriefRelationship[], asChild: BriefRelationship[] }
//   }
//
// One round-trip per relation (Postgres-side joins via embedded selects
// would be cleaner once we lock the column shape; v1 keeps each query
// explicit so payload shape evolution is obvious).
//
// Note (Phase 2 of GITS rename): the wire shape uses the new vocabulary
// (`brief`, `briefId`). The underlying tables / columns
// (`work_items`, `work_item_id`, `work_item_artifacts`, etc.) keep their
// old names until Phase 3 catches up.

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
      auth.client.from("work_items").select("*").eq("id", briefId).single(),
      auth.client
        .from("work_item_content_revisions")
        .select("id, revision_number, content_md, author_actor, reason, created_at")
        .eq("work_item_id", briefId)
        .order("revision_number", { ascending: false }),
      auth.client
        .from("events")
        .select("id, type, actor, payload, idempotency_key, run_id, created_at")
        .eq("work_item_id", briefId)
        .order("created_at", { ascending: false })
        .limit(50),
      auth.client
        .from("runs")
        .select("*")
        .eq("work_item_id", briefId)
        .order("started_at", { ascending: false }),
      auth.client.from("work_item_artifacts").select("*").eq("work_item_id", briefId),
      auth.client
        .from("work_item_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, created_at")
        .eq("parent_id", briefId),
      auth.client
        .from("work_item_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, created_at")
        .eq("child_id", briefId),
    ]);

    if (brief.error || !brief.data) {
      return errorResponse(brief.error?.message ?? "brief not found", 404);
    }

    // Verification results scoped to this Brief's runs.
    const runIds = (runs.data ?? []).map((r) => r.id);
    let verificationResults: unknown[] = [];
    if (runIds.length > 0) {
      const { data: vr, error: vrErr } = await auth.client
        .from("verification_results")
        .select("*")
        .in("run_id", runIds);
      if (vrErr) {
        console.error("[major-get-item] verification fetch failed:", vrErr);
      } else {
        verificationResults = vr ?? [];
      }
    }

    return jsonResponse({
      brief: brief.data,
      contentRevisions: revisions.data ?? [],
      events: events.data ?? [],
      runs: runs.data ?? [],
      verificationResults,
      artifacts: artifacts.data ?? [],
      relationships: {
        asParent: relAsParent.data ?? [],
        asChild: relAsChild.data ?? [],
      },
    });
  } catch (err) {
    console.error("[major-get-item]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
