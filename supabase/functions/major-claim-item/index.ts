// supabase/functions/major-claim-item/index.ts
//
// POST /major-claim-item
//   body: {
//     shellId: string,         // 'shell-A','shell-B'…
//     briefId?: number,        // optional — claim a specific Brief
//     leaseMinutes?: number,   // default 5
//     purpose?: 'execute'|'review'|'triage'|'repair'   // default 'execute'
//   }
//   200: {
//     claimed: true,
//     brief: {                  // camelCase, hydrated with PRD content
//       id, title, status, classifications,
//       expectedArtifactType, expectedPaths,
//       baseBranch, gitRepositoryRef,
//       contentMd, currentRevisionId
//     },
//     run: {                    // camelCase
//       id, purpose, shellId, leaseExpiresAt, inspectedRunId
//     }
//   }
//   409: { claimed: false }   — nothing eligible / lost the race
//
// Implements the Run Start Transaction. Delegates to the
// `major.claim_next_item` RPC, which atomically:
//   1. SELECTs the highest-priority Shell-Eligible Brief with FOR UPDATE
//      SKIP LOCKED (so concurrent Shells never collide).
//   2. UPDATEs status → agent-running.
//   3. INSERTs a `runs` row in 'running' state with lease + heartbeat.
//   4. INSERTs `run-started` and `status-transitioned` Events.
// Single Active Run Rule is enforced by the partial unique index on
// `runs(work_item_id) where outcome='running'` — no two simultaneous Runs.
//
// Note (Phase 2 of GITS rename): the underlying tables / RPC / column names
// (`work_items`, `claim_next_item`, `work_item_id`) keep their old names
// until Phase 3. The wire shape is already on the new vocabulary.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

interface ClaimBody {
  shellId: string;
  briefId?: number;
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
    if (!body?.shellId || typeof body.shellId !== "string") {
      return errorResponse("Invalid body — expected { shellId }", 400);
    }
    const lease = body.leaseMinutes && body.leaseMinutes > 0 ? body.leaseMinutes : 5;
    const purpose = body.purpose ?? "execute";

    // Idempotency: a run that retries this call (e.g., timeout from Shell
    // side) should produce a deterministic key inside the RPC. We seed with
    // the Shell id + a request-scoped UUID; replays with the same id are no-ops.
    const idem = deriveIdempotencyKey(
      body.briefId ?? null,
      "claim-attempt",
      `shell:${body.shellId}`,
      crypto.randomUUID(),
    );

    // Make sure the Shell row exists. The RPC has a FK on the Shell id.
    // Table is still `runner_instances` until Phase 3 renames it to `shells`.
    await auth.client
      .from("runner_instances")
      .upsert({ id: body.shellId, heartbeat_at: new Date().toISOString() }, { onConflict: "id" });

    const { data, error } = await auth.client.rpc("claim_next_item", {
      p_runner_id: body.shellId,
      p_specific_item_id: body.briefId ?? null,
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

    // Hydrate Brief + Run + revision for the Shell so it can start work
    // without extra round trips. Transform to the camelCase shape the
    // Shell's TachikomaBriefSnapshot type expects (snake_case at the DB
    // boundary, camelCase at the API boundary).
    const [briefRes, runRes, revisionRes] = await Promise.all([
      auth.client.from("work_items").select("*").eq("id", row.item_id).single(),
      auth.client.from("runs").select("*").eq("id", row.run_id).single(),
      row.revision_id != null
        ? auth.client.from("work_item_content_revisions")
            .select("id, content_md").eq("id", row.revision_id).single()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (briefRes.error || !briefRes.data) {
      return errorResponse(`work_items lookup failed: ${briefRes.error?.message ?? "no row"}`, 500);
    }
    if (runRes.error || !runRes.data) {
      return errorResponse(`runs lookup failed: ${runRes.error?.message ?? "no row"}`, 500);
    }

    const brief = briefRes.data;
    const run = runRes.data;
    const contentMd = revisionRes.data?.content_md ?? "";

    // Title derivation: first markdown H1 if present, else first non-empty
    // line trimmed to ~80 chars. The Shell uses this for PR titles and
    // logging — never for lifecycle decisions, so a fallback is safe.
    function deriveTitle(md: string, briefId: number): string {
      const h1 = md.match(/^#\s+(.+?)\s*$/m);
      if (h1) return h1[1].trim();
      const firstLine = md.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      if (firstLine) return firstLine.slice(0, 80);
      return `Brief ${briefId} (no PRD content)`;
    }

    return jsonResponse({
      claimed: true,
      brief: {
        id: brief.id,
        title: deriveTitle(contentMd, brief.id),
        status: brief.status,
        classifications: brief.classifications ?? [],
        expectedArtifactType: brief.expected_artifact_type,
        expectedPaths: brief.expected_paths ?? [],
        baseBranch: brief.base_branch,
        gitRepositoryRef: brief.git_repository_ref,
        contentMd,
        currentRevisionId: brief.current_revision_id,
      },
      run: {
        id: run.id,
        purpose: run.purpose,
        shellId: run.runner_id,
        leaseExpiresAt: run.lease_expires_at,
        inspectedRunId: run.inspected_run_id,
      },
    });
  } catch (err) {
    console.error("[major-claim-item]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
