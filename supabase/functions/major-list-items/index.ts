// supabase/functions/major-list-items/index.ts
//
// GET /major-list-items?status=&classification=&limit=&offset=&repo=
//   200: { items: WorkItem[], total: number }
//
// Returns work_items rows with optional filters. Default sort is
// `queue_rank ASC NULLS LAST, created_at ASC` so the runner sees the
// highest-priority Items first.
//
// Filters:
//   - status         CSV (e.g., 'ready-for-agent,ready-for-review')
//   - classification matches if `classifications @> ARRAY[<value>]`
//   - repo           exact match on git_repository_ref
//   - limit          1-200 (default 50)
//   - offset         0+ (default 0)
//
// Used by both the UI (Items View) and the Runner (poll loop).

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
    const statusParam = url.searchParams.get("status");
    const classification = url.searchParams.get("classification");
    const repo = url.searchParams.get("repo");
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    let query = auth.client
      .from("work_items")
      .select(
        "id, status, classifications, expected_artifact_type, expected_paths, git_repository_ref, git_branch, base_branch, pr_status, pr_url, queue_rank, priority_class, placement_reason, source_session_id, current_revision_id, created_at, updated_at",
        { count: "exact" },
      )
      .order("queue_rank", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (statusParam) {
      const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        query = query.eq("status", statuses[0]);
      } else if (statuses.length > 1) {
        query = query.in("status", statuses);
      }
    }
    if (classification) {
      // PostgREST overlap: classifications @> '{<classification>}'
      query = query.contains("classifications", [classification]);
    }
    if (repo) {
      query = query.eq("git_repository_ref", repo);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error("[major-list-items] query failed:", error);
      return errorResponse(error.message, 500);
    }

    return jsonResponse({ items: data ?? [], total: count ?? 0 });
  } catch (err) {
    console.error("[major-list-items]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
