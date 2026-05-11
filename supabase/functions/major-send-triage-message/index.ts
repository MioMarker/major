// supabase/functions/major-send-triage-message/index.ts
//
// POST /major-send-triage-message
//   body: { sessionId: number, content: string }
//   200:  { messages: TriageMessage[], draft_prd: string|null }
//
// Appends the message to the durable transcript and (TODO) re-runs the
// triage Tachikoma to update `draft_prd` based on the conversation so far.
// For v1 we stub the LLM call: the agent always replies inline so the chat
// is never silent. Draft PRD is left unchanged until the real agent runs.
//
// The transcript is stored as JSONB; each entry is { role, content, ts }.
// Lifecycle authority: this endpoint never mutates Briefs. State changes
// happen only when major-finalize-triage-session emits Change Operations.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { errorResponse, jsonResponse } from "../_shared/response.ts";

interface SendMessageBody {
  sessionId: number;
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
    if (!body || typeof body.sessionId !== "number" || typeof body.content !== "string") {
      return errorResponse("Invalid body — expected { sessionId, content }", 400);
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
    const humanEntry = { role: "human" as const, content: body.content, ts: new Date().toISOString() };
    // TODO: replace stub with real triage-Tachikoma call. The agent reads the
    // full transcript and returns a reply + updated draft_prd.
    const agentEntry = {
      role: "agent" as const,
      content: stubAgentReply(body.content),
      ts: new Date().toISOString(),
    };
    const next = [...transcript, humanEntry, agentEntry];
    const nextDraft = session.draft_prd; // don't overwrite draft until real agent runs

    const { error: updErr } = await auth.client
      .from("triage_sessions")
      .update({ transcript: next, draft_prd: nextDraft })
      .eq("id", body.sessionId);

    if (updErr) {
      console.error("[major-send-triage-message] update failed:", updErr);
      return errorResponse(updErr.message, 500);
    }
    return jsonResponse({ messages: [humanEntry, agentEntry], draft_prd: nextDraft });
  } catch (err) {
    console.error("[major-send-triage-message]", err);
    return errorResponse(err instanceof Error ? err.message : "Server error", 500);
  }
});

function stubAgentReply(human: string): string {
  const preview = human.length > 80 ? human.slice(0, 80) + "…" : human;
  return `Got it — "${preview}". To turn this into a Brief I need: (1) affected paths, (2) acceptance criteria, (3) ready-for-agent or ready-for-human? Keep going or hit Submit when you're done.`;
}
