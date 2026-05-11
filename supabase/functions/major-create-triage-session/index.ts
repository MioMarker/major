// supabase/functions/major-create-triage-session/index.ts
//
// POST /major-create-triage-session
//   body (all optional):
//     {
//       entry_point?: string,           // e.g. "integration:github"
//       trigger_payload?: {              // ADR 010 inbound seed
//         source_issue_repo: string,    // 'MioMarker/healthbite'
//         source_issue_number: integer,
//         ...                            // additional source_issue_* fields
//       }
//     }
//   200:  { id: number, status: 'open', created_at: string }
//
// Opens a new Triage Session row. The transcript starts empty and the draft
// PRD is null; both grow over the session via major-send-triage-message.
//
// ADR 010 amendment: when the caller supplies `trigger_payload`, its
// `source_issue_*` fields are persisted on the Triage Session row so the
// downstream Auto Triage Run (and the Triage Tachikoma prompt) can read
// them, and so the resulting Brief's `source_issue_repo` /
// `source_issue_number` columns can be populated when the Change Set's
// `create-brief` operations apply (per ADR 007).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

const TriggerPayloadSchema = z.object({
  source_issue_repo: z.string().min(1),
  source_issue_number: z.number().int().positive(),
  source_issue_url: z.string().optional(),
  source_issue_author_login: z.string().nullable().optional(),
  source_issue_title: z.string().nullable().optional(),
  source_issue_body_md: z.string().nullable().optional(),
  source_issue_created_at: z.string().nullable().optional(),
  github_delivery: z.string().optional(),
}).passthrough();

const CreateBodySchema = z.object({
  entry_point: z.string().optional(),
  trigger_payload: TriggerPayloadSchema.optional(),
}).passthrough();

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    // Body is optional — existing callers POST without one. Parse only if
    // the request carried a non-empty body.
    let body: unknown = {};
    const rawBody = await req.text();
    if (rawBody.trim() !== "") {
      try {
        body = JSON.parse(rawBody);
      } catch (_err) {
        return errorResponse("Invalid JSON body", 400);
      }
    }
    const parsed = CreateBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error.message, 400);
    }

    const insertRow: Record<string, unknown> = {
      initiator_actor: auth.actor,
      status: "open",
      transcript: [],
    };
    if (parsed.data.trigger_payload) {
      insertRow.trigger_payload = parsed.data.trigger_payload;
    }

    const { data, error } = await auth.client
      .from("triage_sessions")
      .insert(insertRow)
      .select("id, status, created_at")
      .single();

    if (error) {
      console.error("[major-create-triage-session] insert failed:", error);
      return errorResponse(error.message, 500);
    }
    return jsonResponse(data);
  } catch (err) {
    console.error("[major-create-triage-session]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});
