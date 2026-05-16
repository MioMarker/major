// supabase/functions/major-create-github-issue/index.ts
//
// POST /major-create-github-issue
//   body: { sessionId: number, repo: string }
//   200:  { url: string, number: number }
//
// Fetches the triage session's draft_prd, uses the first non-empty line as the
// issue title and the full draft_prd as the body, then POSTs to the GitHub
// Issues API. The caller's repo must be one of the three registered repos.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

const ALLOWED_REPOS = [
  "MioMarker/major",
  "MioMarker/healthbite",
  "MioMarker/healix",
] as const;

const CreateGithubIssueRequest = z.object({
  sessionId: z.number().int().positive(),
  repo: z.enum(ALLOWED_REPOS),
});

const GITHUB_API = "https://api.github.com";

const GithubIssueResponse = z.object({
  html_url: z.string(),
  number: z.number(),
});

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = CreateGithubIssueRequest.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.message, 400);

    const { sessionId, repo } = parsed.data;

    const { data: session, error: sessionErr } = await auth.client
      .from("triage_sessions")
      .select("draft_prd")
      .eq("id", sessionId)
      .single();

    if (sessionErr || !session) {
      return errorResponse("Triage session not found", 404);
    }

    const draftPrd: string = session.draft_prd ?? "";
    const firstLine =
      draftPrd
        .split("\n")
        .map((l: string) => l.trim())
        .find((l: string) => l.length > 0) ?? `Triage session #${sessionId}`;
    const title = firstLine.replace(/^#+\s*/, "").trim();

    const githubToken = Deno.env.get("GITHUB_TOKEN");
    if (!githubToken) {
      return errorResponse("GITHUB_TOKEN not configured", 500);
    }

    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body: draftPrd }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[MajorCreateGithubIssue] GitHub API error:", res.status, detail);
      return errorResponse(`GitHub API error: ${res.status}`, 502);
    }

    const ghParsed = GithubIssueResponse.safeParse(await res.json());
    if (!ghParsed.success) {
      return errorResponse("Unexpected GitHub API response shape", 502);
    }
    return jsonResponse({ url: ghParsed.data.html_url, number: ghParsed.data.number });
  } catch (err) {
    console.error("[MajorCreateGithubIssue]", err);
    return errorResponse("Internal server error", 500);
  }
});
