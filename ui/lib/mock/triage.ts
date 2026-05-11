import type { TriageChangeOperation, TriageChangeSet, TriageMessage, TriageSession } from "@/lib/types";

const ago = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();

export const MOCK_TRIAGE_SESSIONS: TriageSession[] = [
  {
    id: 1,
    initiator_actor: "human:jonathan",
    status: "open",
    transcript: [
      {
        role: "human",
        content: "We need to ship the meal report empty state polish before launch.",
        ts: ago(60 * 5),
      },
      {
        role: "agent",
        content:
          "Confirming scope: this is UI-only on `src/components/meals/**`. Any backend changes? What's the desired CTA copy and where should it route?",
        ts: ago(60 * 5 - 1),
      },
      {
        role: "human",
        content: "UI only. CTA: 'Log your first meal' → opens log-meal flow.",
        ts: ago(60 * 4),
      },
    ],
    draft_prd:
      "# Meal report empty state polish\n\n## Acceptance Criteria\n- Empty state shows friendly illustration + CTA.\n- CTA labelled 'Log your first meal' opens log-meal flow.\n\n## Scope Boundaries\n- UI-only.\n\n## Expected Paths\n- `src/components/meals/**`\n",
    entry_point: null,
    trigger_payload: null,
    created_at: ago(60 * 5),
    updated_at: ago(60 * 4),
  },
  {
    id: 2,
    initiator_actor: "human:paul",
    status: "open",
    transcript: [
      {
        role: "human",
        content: "Investigate the streak ring color drift between dark and light mode.",
        ts: ago(60 * 24),
      },
    ],
    draft_prd: null,
    entry_point: "integration:github",
    trigger_payload: {
      source_issue_repo: "MioMarker/healthbite",
      source_issue_number: 42,
      source_issue_title: "Streak ring color drift in dark mode",
    },
    created_at: ago(60 * 24),
    updated_at: ago(60 * 24),
  },
  {
    id: 3,
    initiator_actor: "human:jonathan",
    status: "closed",
    transcript: [
      {
        role: "human",
        content: "Doc out the eval pipeline staging-only constraint.",
        ts: ago(60 * 24 * 5),
      },
      {
        role: "agent",
        content: "Captured. Drafted PRD; one Item proposed.",
        ts: ago(60 * 24 * 5 - 1),
      },
    ],
    draft_prd:
      "# Eval pipeline staging-only docs\n\nMake the staging-only constraint loud in eval-pipeline.md.",
    entry_point: null,
    trigger_payload: null,
    created_at: ago(60 * 24 * 5),
    updated_at: ago(60 * 24 * 4),
  },
];

const SAMPLE_OPERATIONS: TriageChangeOperation[] = [
  {
    id: 30001,
    change_set_id: 4001,
    operation_type: "create-brief",
    payload: {
      classifications: ["feature"],
      expected_artifact_type: "git-change",
      expected_paths: ["src/components/meals/**"],
      git_repository_ref: "MioMarker/healthbite",
      content_md: "# Meal report empty state polish\n...",
    },
    status: "proposed",
    idempotency_key: "create-brief-session-1-op-1",
    applied_actor: null,
    applied_at: null,
    resulting_record_ref: null,
    sequence_index: 0,
    created_at: ago(60),
  },
  {
    id: 30002,
    change_set_id: 4001,
    operation_type: "set-queue-rank",
    payload: { queue_rank: 10, reason: "blocks-onboarding" },
    status: "proposed",
    idempotency_key: "set-queue-rank-session-1-op-2",
    applied_actor: null,
    applied_at: null,
    resulting_record_ref: null,
    sequence_index: 1,
    created_at: ago(60),
  },
];

export const MOCK_DRAFT_CHANGE_SET: TriageChangeSet = {
  id: 4001,
  triage_session_id: 1,
  auto_triage_run_id: null,
  decision: "proposed",
  decision_actor: null,
  decided_at: null,
  summary: "Create meal-report empty-state polish item.",
  needs_human_apply: false,
  blocker_reasons: [],
  created_at: ago(60),
  operations: SAMPLE_OPERATIONS,
};

export function getMockSession(id: number): TriageSession | null {
  return MOCK_TRIAGE_SESSIONS.find((s) => s.id === id) ?? null;
}

export function mockAgentReply(human: string): TriageMessage {
  const ts = new Date().toISOString();
  return {
    role: "agent",
    content: `Thanks. To turn that into a Brief I need: (1) the affected paths, (2) acceptance criteria, (3) the user-facing outcome. Could you confirm? (You said: "${human.slice(0, 80)}${human.length > 80 ? "…" : ""}")`,
    ts,
  };
}
