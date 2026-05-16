// supabase/functions/major-list-external-issues/index.ts
//
// GET /major-list-external-issues
//   200: Array<{ repo, number, title, labels, created_at, url }>
//
// For each registered repo, fetches GitHub issues labeled `needs-triage`.
// Deduplicates by (repo, number), skipping any that already have a triage
// session whose trigger_payload matches.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

const REGISTERED_REPOS = [
  "MioMarker/major",
  "MioMarker/healthbite",
  "MioMarker/healix",
] as const;

const GITHUB_API = "https://api.github.com";
const LABELS = ["needs-triage"];

type GithubIssue = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  labels: Array<{ name: string }>;
};

type ExternalIssue = {
  repo: string;
  number: number;
  title: string;
  labels: string[];
  created_at: string;
  url: string;
};

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const githubToken = Deno.env.get("GITHUB_TOKEN");
    if (!githubToken) {
      return errorResponse("GITHUB_TOKEN not configured", 500);
    }

    const headers = {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    // Fetch all matching issues across all repos.
    const allIssues: ExternalIssue[] = [];
    for (const repo of REGISTERED_REPOS) {
      for (const label of LABELS) {
        const url =
          `${GITHUB_API}/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
          console.error(
            `[MajorListExternalIssues] GitHub API error for ${repo} label=${label}:`,
            res.status,
          );
          continue;
        }
        const issues = await res.json() as GithubIssue[];
        for (const issue of issues) {
          allIssues.push({
            repo,
            number: issue.number,
            title: issue.title,
            labels: issue.labels.map((l) => l.name),
            created_at: issue.created_at,
            url: issue.html_url,
          });
        }
      }
    }

    // Deduplicate by (repo, number).
    const seen = new Set<string>();
    const deduped: ExternalIssue[] = [];
    for (const issue of allIssues) {
      const key = `${issue.repo}:${issue.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(issue);
      }
    }

    // Skip issues that already have a matching triage session.
    const { data: existingSessions } = await auth.client
      .from("triage_sessions")
      .select("trigger_payload");

    const importedKeys = new Set<string>();
    for (const s of existingSessions ?? []) {
      const p = s.trigger_payload as Record<string, unknown> | null;
      if (p && typeof p.source_issue_repo === "string" && p.source_issue_number != null) {
        importedKeys.add(`${p.source_issue_repo}:${String(p.source_issue_number)}`);
      }
    }

    const filtered = deduped.filter(
      (i) => !importedKeys.has(`${i.repo}:${i.number}`),
    );

    return jsonResponse(filtered);
  } catch (err) {
    console.error("[MajorListExternalIssues]", err);
    return errorResponse("Internal server error", 500);
  }
});
