// functions/major-github-webhook/index.ts
//
// POST /major-github-webhook
//   headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
//   body:    GitHub event JSON
//   200:     { ok: true } / 401 / 400
//
// Handles the GitHub webhook events Major cares about:
//   - pull_request    — opened/reopened/closed/edited; updates pr_status,
//                       pr_url on the matching work_item via the PR body's
//                       `Major-item: <id>` Repository Correlation Receipt.
//   - check_run       — completed; inserts verification_results for known
//                       check names against the latest run on the item.
//   - push            — informational only; emits an Event we can use to
//                       drive UI badges, never alters lifecycle status.
//
// Auth: this endpoint authenticates by HMAC-SHA256 signature, NOT by
// Supabase JWT. The function must be deployed with `verify_jwt = false`
// (see functions/config.toml addendum in README.md).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { getAdminClient } from "../_shared/db.ts";
import { verifyGithubSignature } from "../_shared/webhook.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";

const KNOWN_CHECK_NAMES = new Set([
  "tsc-noemit",
  "tests",
  "eval-gate",
  "reviewer-tachikoma",
  "major/review",
]);

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
    if (!secret) return errorResponse("GITHUB_WEBHOOK_SECRET not configured", 500);

    const event = req.headers.get("X-GitHub-Event");
    const delivery = req.headers.get("X-GitHub-Delivery") ?? "no-delivery-id";
    const signature = req.headers.get("X-Hub-Signature-256");

    // We need the raw body to verify the signature (and to JSON-parse).
    const rawBody = await req.text();
    const valid = await verifyGithubSignature(rawBody, signature, secret);
    if (!valid) {
      console.error("[major-github-webhook] signature invalid", { event, delivery });
      return errorResponse("Invalid signature", 401);
    }

    const payload = JSON.parse(rawBody);
    const client = getAdminClient();

    if (event === "pull_request") {
      await handlePullRequest(client, payload, delivery);
    } else if (event === "check_run") {
      await handleCheckRun(client, payload, delivery);
    } else if (event === "push") {
      await handlePush(client, payload, delivery);
    }
    // Anything else → ack and move on.

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[major-github-webhook]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});

// ─────────────────────────────────────────────────────────────────
// pull_request — derive the item id from the PR body's correlation receipt
// ─────────────────────────────────────────────────────────────────
async function handlePullRequest(
  client: ReturnType<typeof getAdminClient>,
  payload: any,
  delivery: string,
): Promise<void> {
  const action = payload.action as string;
  const pr = payload.pull_request;
  if (!pr) return;

  const itemId = parseItemIdFromBody(pr.body);
  if (itemId === null) {
    console.warn(
      "[major-github-webhook] PR has no `Major-item:` receipt; skipping",
      { pr_number: pr.number },
    );
    return;
  }

  const prStatus = derivePrStatus(action, pr);
  const prUrl = pr.html_url as string;

  const { error: updErr } = await client
    .from("work_items")
    .update({ pr_status: prStatus, pr_url: prUrl })
    .eq("id", itemId);
  if (updErr) console.error("[major-github-webhook] work_items update:", updErr);

  await client
    .from("events")
    .insert({
      work_item_id: itemId,
      type: `pr-${action}`,
      actor: "integration:github",
      payload: {
        pr_number: pr.number,
        pr_url: prUrl,
        pr_status: prStatus,
        head_sha: pr.head?.sha,
        base_sha: pr.base?.sha,
        merged: pr.merged,
        delivery,
      },
      idempotency_key: deriveIdempotencyKey(
        itemId,
        `pr-${action}`,
        "integration:github",
        delivery,
      ),
    })
    .select();
}

function parseItemIdFromBody(body: string | null | undefined): number | null {
  if (!body) return null;
  const m = body.match(/Major-item:\s*(\d+)/m);
  return m ? Number(m[1]) : null;
}

function derivePrStatus(action: string, pr: any): "open" | "merged" | "closed" {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  return "open";
}

// ─────────────────────────────────────────────────────────────────
// check_run — record verification result against the latest run
// ─────────────────────────────────────────────────────────────────
async function handleCheckRun(
  client: ReturnType<typeof getAdminClient>,
  payload: any,
  delivery: string,
): Promise<void> {
  const action = payload.action as string;
  if (action !== "completed") return;
  const checkRun = payload.check_run;
  if (!checkRun) return;

  const checkName = checkRun.name as string;
  if (!KNOWN_CHECK_NAMES.has(checkName)) {
    console.log("[major-github-webhook] unknown check_run name; skipping", { checkName });
    return;
  }

  // Find the work item by branch (head_branch on the check_run).
  const branch = checkRun.head_branch as string | undefined;
  if (!branch) return;
  const { data: item } = await client
    .from("work_items")
    .select("id")
    .eq("git_branch", branch)
    .maybeSingle();
  if (!item) return;

  // Latest run for this item.
  const { data: latestRun } = await client
    .from("runs")
    .select("id")
    .eq("work_item_id", item.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestRun) return;

  const conclusion = (checkRun.conclusion as string) ?? "skipped";
  const outcome = conclusion === "success"
    ? "pass"
    : conclusion === "skipped" || conclusion === "neutral"
    ? "skipped"
    : "fail";

  await client
    .from("verification_results")
    .upsert(
      {
        run_id: latestRun.id,
        check_name: checkName,
        outcome,
        required: checkName === "tsc-noemit" || checkName === "tests",
        requiredness_source: "artifact-type-policy",
        payload: { details_url: checkRun.details_url, conclusion, delivery },
      },
      { onConflict: "run_id,check_name" },
    );
}

// ─────────────────────────────────────────────────────────────────
// push — informational event only
// ─────────────────────────────────────────────────────────────────
async function handlePush(
  client: ReturnType<typeof getAdminClient>,
  payload: any,
  delivery: string,
): Promise<void> {
  const ref = payload.ref as string | undefined;
  if (!ref || !ref.startsWith("refs/heads/major/work-item-")) return;

  const branch = ref.replace("refs/heads/", "");
  const { data: item } = await client
    .from("work_items")
    .select("id")
    .eq("git_branch", branch)
    .maybeSingle();
  if (!item) return;

  await client
    .from("events")
    .insert({
      work_item_id: item.id,
      type: "git-push-observed",
      actor: "integration:github",
      payload: {
        head_sha: payload.after,
        before_sha: payload.before,
        commits: payload.commits?.length ?? 0,
        delivery,
      },
      idempotency_key: deriveIdempotencyKey(
        item.id,
        "git-push-observed",
        "integration:github",
        delivery,
      ),
    })
    .select();
}
