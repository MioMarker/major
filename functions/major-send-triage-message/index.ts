// functions/major-send-triage-message/index.ts
//
// POST /major-send-triage-message
//   body: { sessionId: number, role: 'user'|'assistant', content: string }
//   200:  { transcript: array, draft_prd: string|null }
//
// Appends the message to the durable transcript and (TODO) re-runs the
// triage Tachikoma to update `draft_prd` based on the conversation so far.
// For v1 we stub the LLM call: if role==='user' we mirror the user message
// into a placeholder PRD so the UI flow can be wired end-to-end without
// blocking on the prompt + model decision.
//
// The transcript is stored as JSONB; each entry is { role, content, ts }.
// Lifecycle authority: this endpoint never mutates Work Items. State changes
// happen only when major-finalize-triage-session emits Change Operations.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface SendMessageBody {
  sessionId: number;
  role: "user" | "assistant";
  content: string;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const body = (await req.json()) as SendMessageBody;
    if (!body || typeof body.sessionId !== "number" || !body.role || typeof body.content !== "string") {
      return errorResponse("Invalid body — expected { sessionId, role, content }", 400);
    }
    if (body.role !== "user" && body.role !== "assistant") {
      return errorResponse("role must be 'user' or 'assistant'", 400);
    }

    const { data: session, error: fetchErr } = await auth.client
      .from("triage_sessions")
      .select("id, transcript, draft_prd, status")
      .eq("id", body.sessionId)
      .single();

    if (fetchErr || !session) {
      return errorResponse(fetchErr?.message ?? "session not found", 404);
    }
    if (session.status !== "open") {
      return errorResponse("Session is not open", 409);
    }

    const transcript = Array.isArray(session.transcript) ? session.transcript : [];
    const next = [
      ...transcript,
      { role: body.role, content: body.content, ts: new Date().toISOString() },
    ];

    // TODO: replace with a real triage-Tachikoma call. The triage role prompt
    // reads the full transcript and emits an updated `draft_prd`. For now we
    // forward the latest user message directly so UI integration can proceed.
    let nextDraft = session.draft_prd ?? null;
    if (body.role === "user") {
      nextDraft = stubDraftFromTranscript(next);
    }

    const { data: updated, error: updErr } = await auth.client
      .from("triage_sessions")
      .update({ transcript: next, draft_prd: nextDraft })
      .eq("id", body.sessionId)
      .select("transcript, draft_prd")
      .single();

    if (updErr) {
      console.error("[major-send-triage-message] update failed:", updErr);
      return errorResponse(updErr.message, 500);
    }
    return jsonResponse(updated);
  } catch (err) {
    console.error("[major-send-triage-message]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});

function stubDraftFromTranscript(transcript: Array<{ role: string; content: string }>): string {
  const user = transcript.filter((t) => t.role === "user").map((t) => t.content).join("\n\n");
  return `# Draft PRD (stub)\n\n${user}\n\n_(Replace with triage-Tachikoma output once wired.)_`;
}
