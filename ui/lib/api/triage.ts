import {
  MOCK_DRAFT_CHANGE_SET,
  MOCK_TRIAGE_SESSIONS,
  getMockSession,
  mockAgentReply,
} from "@/lib/mock/triage";
import type {
  ExternalIssue,
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
      entry_point: null,
      trigger_payload: null,
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
  return majorFetch<{ messages: TriageMessage[]; draft_prd: string | null }>(
    "major-send-triage-message",
    {
      method: "POST",
      body: { sessionId, content },
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

export async function createGithubIssue(
  sessionId: number,
  repo: string,
  authToken?: string,
): Promise<{ url: string; number: number }> {
  if (USE_MOCK) {
    return { url: "https://github.com/MioMarker/major/issues/99", number: 99 };
  }
  return majorFetch<{ url: string; number: number }>("major-create-github-issue", {
    method: "POST",
    body: { sessionId, repo },
    authToken,
  });
}

export async function listExternalIssues(
  authToken?: string,
): Promise<ExternalIssue[]> {
  if (USE_MOCK) {
    return [
      {
        repo: "MioMarker/healthbite",
        number: 42,
        title: "Streak ring color drift in dark mode",
        labels: ["needs-triage", "bug"],
        created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        url: "https://github.com/MioMarker/healthbite/issues/42",
      },
      {
        repo: "MioMarker/healix",
        number: 7,
        title: "Onboarding flow skips permissions step on Android 14",
        labels: ["major:triage"],
        created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        url: "https://github.com/MioMarker/healix/issues/7",
      },
      {
        repo: "MioMarker/major",
        number: 81,
        title: "Shell heartbeat delay causes spurious reaper cancellations",
        labels: ["needs-triage"],
        created_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        url: "https://github.com/MioMarker/major/issues/81",
      },
    ];
  }
  return majorFetch<ExternalIssue[]>("major-list-external-issues", { authToken });
}

export async function importExternalIssues(
  issues: Array<{ repo: string; number: number }>,
  authToken?: string,
): Promise<{ imported: number }> {
  if (USE_MOCK) {
    return { imported: issues.length };
  }
  return majorFetch<{ imported: number }>("major-import-external-issues", {
    method: "POST",
    body: { issues },
    authToken,
  });
}

export async function deleteTriageSession(
  sessionId: number,
  authToken?: string,
): Promise<{ sessionId: number; deleted: boolean }> {
  if (USE_MOCK) {
    return { sessionId, deleted: true };
  }
  return majorFetch<{ sessionId: number; deleted: boolean }>("major-delete-triage-session", {
    method: "POST",
    body: { sessionId },
    authToken,
  });
}

export interface AutoTriageSessionResult {
  sessionId: number;
  title: string;
  outcome: "triaged" | "needs_human_apply" | "failed";
  changeSetId?: number;
  summary: string;
  error?: string;
}

export interface AutoTriageResponse {
  processed: number;
  triaged: number;
  needs_human_apply: number;
  failed: number;
  results: AutoTriageSessionResult[];
}

export async function autoTriageSessions(
  authToken?: string,
): Promise<AutoTriageResponse> {
  if (USE_MOCK) {
    return {
      processed: 2,
      triaged: 1,
      needs_human_apply: 1,
      failed: 0,
      results: [
        {
          sessionId: 1,
          title: "Mock session 1",
          outcome: "triaged",
          changeSetId: 101,
          summary: "Created feature Brief and set ready-for-agent.",
        },
        {
          sessionId: 2,
          title: "Mock session 2",
          outcome: "needs_human_apply",
          changeSetId: 102,
          summary: "Proposed Brief — path-blocker flagged for human review.",
        },
      ],
    };
  }
  return majorFetch<AutoTriageResponse>("major-auto-triage-sessions", {
    method: "POST",
    body: {},
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
