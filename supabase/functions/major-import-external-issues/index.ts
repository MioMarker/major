// supabase/functions/major-import-external-issues/index.ts
//
// POST /major-import-external-issues
//   body: { issues: Array<{ repo: string, number: number }> }
//   200:  { imported: number }
//
// For each issue, fetches the title from GitHub then creates a triage session
// with entry_point "integration:github" and a trigger_payload recording the
// source issue coordinates. Uses the service-role client so it acts on behalf
// of the Cyberbrain, not the calling user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

const ALLOWED_REPOS = [
  "MioMarker/major",
  "MioMarker/healthbite",
  "MioMarker/healix",
] as const;

const ImportExternalIssuesRequest = z.object({
  issues: z
    .array(
      z.object({
        repo: z.enum(ALLOWED_REPOS),
        number: z.number().int().positive(),
      }),
    )
    .min(1),
});

const GITHUB_API = "https://api.github.com";

const GithubIssueResponse = z.object({
  title: z.string(),
  body: z.string().nullable(),
});

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = ImportExternalIssuesRequest.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.message, 400);

    const { issues } = parsed.data;

    const githubToken = Deno.env.get("GITHUB_TOKEN");
    if (!githubToken) {
      return errorResponse("GITHUB_TOKEN not configured", 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return errorResponse("Server misconfiguration", 500);
    }

    // Use the service-role client: creating sessions is a Cyberbrain action,
    // not a user action. We still authenticate the calling user above so the
    // endpoint isn't open to anonymous callers.
    const serviceClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: "major" },
    });

    const githubHeaders = {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    let imported = 0;
    for (const issue of issues) {
      // Fetch the issue title from GitHub.
      const res = await fetch(
        `${GITHUB_API}/repos/${issue.repo}/issues/${issue.number}`,
        { headers: githubHeaders },
      );
      if (!res.ok) {
        console.error(
          `[MajorImportExternalIssues] GitHub fetch failed for ${issue.repo}#${issue.number}:`,
          res.status,
        );
        continue;
      }
      const ghParsed = GithubIssueResponse.safeParse(await res.json());
      if (!ghParsed.success) {
        console.error(`[MajorImportExternalIssues] unexpected response shape for ${issue.repo}#${issue.number}`);
        continue;
      }
      const ghIssue = ghParsed.data;

      const { error } = await serviceClient
        .from("triage_sessions")
        .insert({
          initiator_actor: auth.actor,
          status: "open",
          transcript: [],
          entry_point: "integration:github",
          trigger_payload: {
            source_issue_repo: issue.repo,
            source_issue_number: issue.number,
            source_issue_title: ghIssue.title,
            source_issue_body_md: ghIssue.body ?? "",
          },
        });

      if (error) {
        console.error(
          `[MajorImportExternalIssues] insert failed for ${issue.repo}#${issue.number}:`,
          error,
        );
        continue;
      }
      imported++;
    }

    return jsonResponse({ imported });
  } catch (err) {
    console.error("[MajorImportExternalIssues]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
