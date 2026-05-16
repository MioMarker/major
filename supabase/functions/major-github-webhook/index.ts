// supabase/functions/major-github-webhook/index.ts
//
// POST /major-github-webhook
//   headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
//   body:    GitHub event JSON
//   200:     { ok: true } / 401 / 400
//
// Handles the GitHub webhook events Major cares about:
//   - pull_request    — opened/reopened/closed/edited; updates pr_status,
//                       pr_url, pr_derived_facts on the matching Brief via the
//                       PR body's `Major-brief: <id>` Repository Correlation
//                       Receipt. On `closed` actions (merged or unmerged), also
//                       transitions the Brief to a terminal state and
//                       (when applicable) closes the source GitHub issue
//                       per ADR 007.
//   - check_run       — completed; inserts verification_results for known
//                       check names against the latest run on the Brief.
//   - push            — informational only; emits an Event we can use to
//                       drive UI badges, never alters lifecycle status.
//   - issues          — opened/labeled with `needs-triage`; seeds a Triage
//                       Session per ADR 010 (inbound GitHub issue →
//                       Triage Session). See `handleIssue`.
//
// Auth: this endpoint authenticates by HMAC-SHA256 signature, NOT by
// Supabase JWT. The function must be deployed with `verify_jwt = false`
// (see functions/config.toml addendum in README.md).
//
// `Deno.serve` is wrapped in `if (import.meta.main)` so the test file can
// `import { handleIssue, handlePullRequest } from "./index.ts"` without
// binding a network port. Supabase invokes the function as the module entry
// point, so `import.meta.main` is `true` in deployment.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";
import { getAdminClient, type MajorClient } from "../_shared/db.ts";
import { verifyGithubSignature } from "../_shared/webhook.ts";
import { deriveIdempotencyKey } from "../_shared/idempotency.ts";
import { parseBriefIdFromBody } from "./parse-pr-receipt.ts";

// F-17a: Added "tachikoma-implementer" to the known check names set.
const KNOWN_CHECK_NAMES = new Set([
  "tsc-noemit",
  "tests",
  "eval-gate",
  "reviewer-tachikoma",
  "tachikoma-implementer",
  "major/review",
]);

// ADR 010: inbound trigger gate.
const TRIAGE_LABEL = "needs-triage";
const WATCHED_REPOS = new Set([
  "MioMarker/major",
  "MioMarker/healthbite",
  "MioMarker/healix",
]);

if (import.meta.main) {
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
      } else if (event === "issues") {
        await handleIssue(client, payload, delivery);
      }
      // Anything else → ack and move on.

      return jsonResponse({ ok: true });
    } catch (err) {
      console.error("[major-github-webhook]", err);
      return errorResponse("Internal server error", 500);
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// pull_request — derive the Brief id from the PR body's correlation receipt
// ─────────────────────────────────────────────────────────────────
export async function handlePullRequest(
  client: ReturnType<typeof getAdminClient>,
  payload: any,
  delivery: string,
): Promise<void> {
  const action = payload.action as string;
  const pr = payload.pull_request;
  if (!pr) return;

  const briefId = parseBriefIdFromBody(pr.body);
  if (briefId === null) {
    // F-17c: emit a Telemetry Record for PRs with no correlation receipt so
    // operators can investigate untracked PRs. Don't process further.
    console.warn(
      "[major-github-webhook] PR has no `Major-brief:` receipt; emitting telemetry",
      { pr_number: pr.number },
    );
    await client
      .from("telemetry_records")
      .insert({
        observation_type: "pr-no-receipt",
        brief_id: null,
        run_id: null,
        idempotency_key: deriveIdempotencyKey(null, "pr-no-receipt", "integration:github", delivery),
        payload: { pr_number: pr.number, pr_url: pr.html_url as string, delivery },
      })
      .select();
    return;
  }

  const prStatus = derivePrStatus(action, pr);
  const prUrl = pr.html_url as string;

  // F-17b: include pr_derived_facts alongside pr_status and pr_url.
  // The pr_derived_facts JSONB column lands with Stream A's migration; the
  // update compiles now but no-ops at runtime until that column exists.
  const prDerivedFacts = {
    mergeable: pr.mergeable ?? null,
    draft: pr.draft ?? false,
    requested_reviewer_count: (pr.requested_reviewers ?? []).length,
    requested_team_count: (pr.requested_teams ?? []).length,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changed_files ?? null,
  };

  const { error: updErr } = await client
    .from("briefs")
    .update({ pr_status: prStatus, pr_url: prUrl, pr_derived_facts: prDerivedFacts })
    .eq("id", briefId);
  if (updErr) console.error("[major-github-webhook] briefs update:", updErr);

  await client
    .from("events")
    .insert({
      brief_id: briefId,
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
        briefId,
        `pr-${action}`,
        "integration:github",
        delivery,
      ),
    })
    .select();

  // ADR 007: on terminal PR actions, transition the Brief and (if applicable)
  // close the source GitHub issue. The `pr-${action}` Event above remains the
  // canonical record of the webhook itself; the Brief transition below is the
  // lifecycle effect.
  if (action === "closed") {
    await maybeAutoCloseBrief(client, briefId, pr, delivery);
  }
}

// ─────────────────────────────────────────────────────────────────
// pull_request.closed → Brief terminal transition (ADR 007)
// ─────────────────────────────────────────────────────────────────
async function maybeAutoCloseBrief(
  client: ReturnType<typeof getAdminClient>,
  briefId: number,
  pr: any,
  delivery: string,
): Promise<void> {
  const { data: brief, error: lookupErr } = await client
    .from("briefs")
    .select("id, status, source_issue_repo, source_issue_number")
    .eq("id", briefId)
    .maybeSingle();
  if (lookupErr) {
    console.error("[major-github-webhook] auto-close brief lookup:", lookupErr);
    return;
  }
  if (!brief) return;

  // Already-terminal Briefs are a no-op (e.g. webhook redelivery).
  if (brief.status === "done" || brief.status === "wontfix") return;

  const merged = !!pr.merged;
  const targetStatus = merged ? "done" : "wontfix";

  // Attribute the transition to the actual GitHub user who acted. The merge
  // path uses pr.merged_by; the unmerged-close path falls back to pr.closed_by
  // and then pr.user. CLAUDE.md amendment in PR #34 records this as the
  // human-Actor exception to the agents-can't-set-done rule.
  const actorLogin = merged
    ? (pr.merged_by?.login ?? pr.user?.login ?? "unknown")
    : (pr.closed_by?.login ?? pr.user?.login ?? "unknown");
  const actor = `human:${actorLogin}`;

  // Atomic transition: the .neq filters absorb the race where another delivery
  // reached terminal first. Affects 0 rows on race; we treat that as success.
  const { error: updErr } = await client
    .from("briefs")
    .update({ status: targetStatus })
    .eq("id", briefId)
    .neq("status", "done")
    .neq("status", "wontfix");
  if (updErr) {
    console.error("[major-github-webhook] auto-close brief update:", updErr);
    return;
  }

  // status-transitioned Event with idempotency key. Same delivery → same key
  // → duplicate insert is a no-op via UNIQUE constraint.
  await client
    .from("events")
    .insert({
      brief_id: briefId,
      type: "status-transitioned",
      actor,
      payload: {
        kind: "status-transitioned",
        from: brief.status,
        to: targetStatus,
        reason: `pull_request.closed (merged=${merged})`,
        pr_number: pr.number,
        pr_url: pr.html_url,
        delivery,
      },
      idempotency_key: deriveIdempotencyKey(
        briefId,
        "status-transitioned",
        actor,
        delivery,
      ),
    })
    .select();

  // Source-issue close (only on merged → done; per ADR 007, closing a PR
  // without merge does NOT imply rejecting the underlying request). Both
  // columns are nullable; narrow before passing to the typed helper.
  if (targetStatus === "done") {
    const issueRepo = brief.source_issue_repo;
    const issueNumber = brief.source_issue_number;
    if (typeof issueRepo === "string" && typeof issueNumber === "number") {
      await closeSourceIssue(issueRepo, issueNumber, pr, briefId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Source-issue close via GitHub REST API (ADR 007)
// ─────────────────────────────────────────────────────────────────
async function closeSourceIssue(
  repo: string,
  issueNumber: number,
  pr: any,
  briefId: number,
): Promise<void> {
  const token = Deno.env.get("GITHUB_APP_TOKEN");
  if (!token) {
    console.error(
      "[major-github-webhook] issue-close-failed: GITHUB_APP_TOKEN not configured",
      { repo, issueNumber, briefId },
    );
    return;
  }

  const commonHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // Comment first so the close has context. Both calls are best-effort —
  // failure here does NOT abort the Brief transition (per ADR 007); the
  // operator triages per docs/failure-modes.md § 18.
  const commentRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        body:
          `Closed by [${repo}#${pr.number}](${pr.html_url}) (Major Brief #${briefId}).`,
      }),
    },
  );
  if (!commentRes.ok) {
    console.error("[major-github-webhook] issue-close-failed (comment):", {
      repo,
      issueNumber,
      briefId,
      status: commentRes.status,
      body: await commentRes.text().catch(() => ""),
    });
    return;
  }

  const closeRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: commonHeaders,
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    },
  );
  if (!closeRes.ok) {
    console.error("[major-github-webhook] issue-close-failed (close):", {
      repo,
      issueNumber,
      briefId,
      status: closeRes.status,
      body: await closeRes.text().catch(() => ""),
    });
  }
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

  // Find the Brief by branch (head_branch on the check_run).
  const branch = checkRun.head_branch as string | undefined;
  if (!branch) return;
  const { data: brief } = await client
    .from("briefs")
    .select("id")
    .eq("git_branch", branch)
    .maybeSingle();
  if (!brief) return;

  // Latest run for this Brief.
  const { data: latestRun } = await client
    .from("runs")
    .select("id")
    .eq("brief_id", brief.id)
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
  // Accept both the new `major/brief-<n>` branch convention (Phase 2) and
  // the legacy `major/work-item-<n>` convention so historical branches still
  // emit Events.
  const isBriefBranch = !!ref && (
    ref.startsWith("refs/heads/major/brief-") ||
    ref.startsWith("refs/heads/major/work-item-")
  );
  if (!ref || !isBriefBranch) return;

  const branch = ref.replace("refs/heads/", "");
  const { data: brief } = await client
    .from("briefs")
    .select("id")
    .eq("git_branch", branch)
    .maybeSingle();
  if (!brief) return;

  await client
    .from("events")
    .insert({
      brief_id: brief.id,
      type: "git-push-observed",
      actor: "integration:github",
      payload: {
        head_sha: payload.after,
        before_sha: payload.before,
        commits: payload.commits?.length ?? 0,
        delivery,
      },
      idempotency_key: deriveIdempotencyKey(
        brief.id,
        "git-push-observed",
        "integration:github",
        delivery,
      ),
    })
    .select();
}

// ─────────────────────────────────────────────────────────────────
// issues — ADR 010 inbound: seed a Triage Session iff the gate passes
// ─────────────────────────────────────────────────────────────────
// Gate (all must hold):
//   - action === "opened" with `needs-triage` label, OR action === "labeled"
//     with the just-added label === "needs-triage" on an open issue
//   - sender.type === "User"
//   - repository.full_name ∈ WATCHED_REPOS
//   - no non-finalized Triage Session already exists for this issue (idempotency)
//
// On pass: insert a new `major.triage_sessions` row with the issue body
// captured in `trigger_payload`, and emit a `triage-session-created`
// Event with an idempotency key derived from the GitHub delivery id.
//
// On any redelivery (same delivery id), the Event UNIQUE(idempotency_key)
// constraint absorbs the duplicate; the session-existence check absorbs
// re-fires that arrive with a fresh delivery id but target the same issue.
//
// deno-lint-ignore no-explicit-any -- GitHub webhook payloads are JSON;
// matches the existing `handlePullRequest` signature in this file.
export async function handleIssue(
  client: MajorClient,
  payload: any,
  delivery: string,
): Promise<void> {
  const action = payload?.action as string | undefined;
  const issue = payload?.issue;
  const sender = payload?.sender;
  const repoFullName = payload?.repository?.full_name as string | undefined;

  if (!action || !issue || !sender || !repoFullName) return;

  // Universal gates first — cheapest checks, no DB hit.
  if (sender.type !== "User") return;
  if (!WATCHED_REPOS.has(repoFullName)) return;

  // Action-specific trigger condition.
  let shouldTrigger = false;
  if (action === "opened") {
    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    shouldTrigger = labels.some(
      (l: { name?: string } | null | undefined) => l?.name === TRIAGE_LABEL,
    );
  } else if (action === "labeled") {
    const addedLabel = payload?.label?.name as string | undefined;
    shouldTrigger = addedLabel === TRIAGE_LABEL && issue.state === "open";
  }
  if (!shouldTrigger) return;

  // Idempotency: a non-finalized (status='open') Triage Session keyed on
  // (source_issue_repo, source_issue_number) blocks re-trigger. Finalized
  // (status='closed') Sessions do not block — operator may re-trigger after
  // rejecting the prior Session's Briefs.
  const issueNumber = issue.number as number;
  const { data: existingSession, error: lookupErr } = await client
    .from("triage_sessions")
    .select("id")
    .eq("trigger_payload->>source_issue_repo", repoFullName)
    .eq("trigger_payload->>source_issue_number", String(issueNumber))
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    console.error("[major-github-webhook] handleIssue lookup failed:", lookupErr);
    return;
  }
  if (existingSession) {
    console.log("[major-github-webhook] handleIssue: open Triage Session exists; skipping", {
      repo: repoFullName,
      issue_number: issueNumber,
      session_id: existingSession.id,
    });
    return;
  }

  const triggerPayload = {
    source_issue_repo: repoFullName,
    source_issue_number: issueNumber,
    source_issue_url: issue.html_url ?? null,
    source_issue_author_login: issue.user?.login ?? null,
    source_issue_title: issue.title ?? null,
    source_issue_body_md: issue.body ?? null,
    source_issue_created_at: issue.created_at ?? null,
    github_delivery: delivery,
  };

  const { data: session, error: insertErr } = await client
    .from("triage_sessions")
    .insert({
      initiator_actor: "integration:github",
      entry_point: "integration:github",
      status: "open",
      transcript: [],
      trigger_payload: triggerPayload,
    })
    .select("id")
    .single();
  if (insertErr) {
    console.error("[major-github-webhook] handleIssue insert session:", insertErr);
    return;
  }

  await client
    .from("events")
    .insert({
      brief_id: null,
      type: "triage-session-created",
      actor: "integration:github",
      payload: {
        triage_session_id: session?.id ?? null,
        entry_point: "integration:github",
        source_issue_repo: repoFullName,
        source_issue_number: issueNumber,
        delivery,
      },
      idempotency_key: deriveIdempotencyKey(
        null,
        "triage-session-created",
        "integration:github",
        delivery,
      ),
    })
    .select();
}
