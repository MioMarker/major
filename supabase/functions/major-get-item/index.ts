// supabase/functions/major-get-item/index.ts
//
// GET /major-get-item?itemId=<n>
//   200: {
//     item: WorkItem,
//     contentRevisions: ContentRevision[],   // newest first
//     events: Event[],                       // last 50, newest first
//     runs: Run[],
//     verificationResults: VerificationResult[],   // joined under their run
//     artifacts: WorkItemArtifact[],
//     relationships: { asParent: Relationship[], asChild: Relationship[] }
//   }
//
// One round-trip per relation (Postgres-side joins via embedded selects
// would be cleaner once we lock the column shape; v1 keeps each query
// explicit so payload shape evolution is obvious).

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
    const itemId = Number(url.searchParams.get("itemId"));
    if (!itemId || Number.isNaN(itemId)) {
      return errorResponse("Missing or invalid itemId", 400);
    }

    const [item, revisions, events, runs, artifacts, relAsParent, relAsChild] = await Promise.all([
      auth.client.from("work_items").select("*").eq("id", itemId).single(),
      auth.client
        .from("work_item_content_revisions")
        .select("id, revision_number, content_md, author_actor, reason, created_at")
        .eq("work_item_id", itemId)
        .order("revision_number", { ascending: false }),
      auth.client
        .from("events")
        .select("id, type, actor, payload, idempotency_key, run_id, created_at")
        .eq("work_item_id", itemId)
        .order("created_at", { ascending: false })
        .limit(50),
      auth.client
        .from("runs")
        .select("*")
        .eq("work_item_id", itemId)
        .order("started_at", { ascending: false }),
      auth.client.from("work_item_artifacts").select("*").eq("work_item_id", itemId),
      auth.client
        .from("work_item_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, created_at")
        .eq("parent_id", itemId),
      auth.client
        .from("work_item_relationships")
        .select("id, parent_id, child_id, type, parent_review_requirement, excluded_reason, created_at")
        .eq("child_id", itemId),
    ]);

    if (item.error || !item.data) {
      return errorResponse(item.error?.message ?? "item not found", 404);
    }

    // Verification results scoped to this item's runs.
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
      item: item.data,
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
