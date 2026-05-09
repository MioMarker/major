import {
  MOCK_DRAFT_CHANGE_SET,
  MOCK_TRIAGE_SESSIONS,
  getMockSession,
  mockAgentReply,
} from "@/lib/mock/triage";
import type {
  TriageChangeSet,
  TriageMessage,
  TriageSession,
} from "@/lib/types";
import { USE_MOCK, majorFetch } from "@/lib/api/client";

export async function listTriageSessions(authToken?: string): Promise<TriageSession[]> {
  if (USE_MOCK) {
    return MOCK_TRIAGE_SESSIONS;
  }
  return majorFetch<TriageSession[]>("major-list-triage-sessions", {
    authToken,
  });
}

export async function getTriageSession(
  id: number,
  authToken?: string,
): Promise<TriageSession | null> {
  if (USE_MOCK) {
    return getMockSession(id);
  }
  return majorFetch<TriageSession>("major-get-triage-session", {
    query: { id },
    authToken,
  });
}

export async function createTriageSession(
  initiatorActor: string,
  authToken?: string,
): Promise<TriageSession> {
  if (USE_MOCK) {
    const newId = Math.max(...MOCK_TRIAGE_SESSIONS.map((s) => s.id)) + 1;
    const now = new Date().toISOString();
    const session: TriageSession = {
      id: newId,
      initiator_actor: initiatorActor,
      status: "open",
      transcript: [],
      draft_prd: null,
      created_at: now,
      updated_at: now,
    };
    MOCK_TRIAGE_SESSIONS.push(session);
    return session;
  }
  return majorFetch<TriageSession>("major-create-triage-session", {
    method: "POST",
    body: { initiator_actor: initiatorActor },
    authToken,
  });
}

export async function sendTriageMessage(
  sessionId: number,
  content: string,
  authToken?: string,
): Promise<{ messages: TriageMessage[]; draft_prd: string | null }> {
  if (USE_MOCK) {
    const session = getMockSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const human: TriageMessage = {
      role: "human",
      content,
      ts: new Date().toISOString(),
    };
    const agent = mockAgentReply(content);
    session.transcript = [...session.transcript, human, agent];
    session.updated_at = new Date().toISOString();
    return { messages: [human, agent], draft_prd: session.draft_prd };
  }
  // API contract: { sessionId, role, content }. Returns { transcript, draft_prd }.
  // The UI calls only with the human's user role; the backend appends an
  // assistant reply through the triage Tachikoma (deferred LLM stub in v1).
  return majorFetch<{ messages: TriageMessage[]; draft_prd: string | null }>(
    "major-send-triage-message",
    {
      method: "POST",
      body: { sessionId, role: "user", content },
      authToken,
    },
  );
}

export async function finalizeTriageSession(
  sessionId: number,
  authToken?: string,
): Promise<TriageChangeSet> {
  if (USE_MOCK) {
    return { ...MOCK_DRAFT_CHANGE_SET, triage_session_id: sessionId };
  }
  // API contract: { sessionId, summary?, operations: ChangeOp[] }
  // Returns { changeSetId, needsHumanApply, blockerReasons, appliedOpCount }.
  // TODO(phase-3-followup): the UI does not yet construct ChangeOps client-side;
  // operations should come from the triage Tachikoma's draft attached to the
  // session (deferred LLM wiring). For now we send an empty array, which is a
  // no-op on the server until the triage Tachikoma populates draft operations.
  return majorFetch<TriageChangeSet>("major-finalize-triage-session", {
    method: "POST",
    body: { sessionId, operations: [] },
    authToken,
  });
}

export async function applyChangeSet(
  changeSetId: number,
  authToken?: string,
): Promise<{ applied: number; blocked: number }> {
  if (USE_MOCK) {
    return { applied: 2, blocked: 0 };
  }
  // API contract: { changeSetId } returns { appliedOpCount }.
  // We re-shape to the UI's existing { applied, blocked } contract; blocked
  // count is derivable via subsequent get-item calls (or future UI re-design).
  const resp = await majorFetch<{ appliedOpCount: number }>(
    "major-apply-change-set",
    {
      method: "POST",
      body: { changeSetId },
      authToken,
    },
  );
  return { applied: resp.appliedOpCount, blocked: 0 };
}
