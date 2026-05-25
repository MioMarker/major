import type { Brief, BriefArtifact, BriefContentRevision, BriefDetail, BriefRelationship, MajorEvent, Run, VerificationResult } from "@/lib/types";

const now = () => new Date().toISOString();
const ago = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();

export const MOCK_BRIEFS: Brief[] = [
  {
    id: 101,
    title: "Meal report empty-state polish",
    status: "ready-for-agent",
    classifications: ["feature"],
    expected_artifact_type: "git-change",
    expected_paths: ["src/components/meals/**", "src/hooks/usePendingMealsStore.ts"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-101",
    base_branch: "dev",
    pr_status: "absent",
    pr_url: null,
    queue_rank: 10,
    priority_class: "p1",
    placement_reason: "blocks-onboarding",
    source_session_id: 1,
    current_revision_id: 201,
    created_at: ago(60 * 24),
    updated_at: ago(45),
  },
  {
    id: 102,
    title: "Fix submitMealAsync race condition",
    status: "agent-running",
    classifications: ["bug-fix"],
    expected_artifact_type: "git-change",
    expected_paths: ["src/services/meals/submitMealAsync.ts"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-102",
    base_branch: "dev",
    pr_status: "absent",
    pr_url: null,
    queue_rank: 20,
    priority_class: null,
    placement_reason: null,
    source_session_id: 1,
    current_revision_id: 202,
    created_at: ago(60 * 6),
    updated_at: ago(5),
  },
  {
    id: 103,
    title: "MealReportsView v2 — chart polish",
    status: "ready-for-review",
    classifications: ["feature"],
    expected_artifact_type: "git-change",
    expected_paths: ["src/components/MealReportsView.tsx"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-103",
    base_branch: "dev",
    pr_status: "open",
    pr_url: "https://github.com/MioMarker/healthbite/pull/271",
    queue_rank: 5,
    priority_class: "p0",
    placement_reason: "preview-launch",
    source_session_id: 2,
    current_revision_id: 203,
    created_at: ago(60 * 24 * 2),
    updated_at: ago(120),
  },
  {
    id: 104,
    title: null,
    status: "ready-for-triage",
    classifications: ["refactor"],
    expected_artifact_type: null,
    expected_paths: [],
    git_repository_ref: null,
    git_branch: null,
    base_branch: "dev",
    pr_status: "absent",
    pr_url: null,
    queue_rank: null,
    priority_class: null,
    placement_reason: null,
    source_session_id: 2,
    current_revision_id: 204,
    created_at: ago(30),
    updated_at: ago(30),
  },
  {
    id: 105,
    title: "Insights analytics tab — weekly breakdown",
    status: "needs-info",
    classifications: ["feature"],
    expected_artifact_type: "git-change",
    expected_paths: ["src/app/(tabs)/insights.tsx"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: null,
    base_branch: "dev",
    pr_status: "absent",
    pr_url: null,
    queue_rank: null,
    priority_class: null,
    placement_reason: null,
    source_session_id: 3,
    current_revision_id: 205,
    created_at: ago(60 * 4),
    updated_at: ago(60),
  },
  {
    id: 106,
    title: "Fix analyze-meal AI timeout on slow connections",
    status: "ready-for-human",
    classifications: ["bug-fix"],
    expected_artifact_type: "git-change",
    expected_paths: ["supabase/functions/analyze-meal-ai/**"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-106",
    base_branch: "dev",
    pr_status: "absent",
    pr_url: null,
    queue_rank: 30,
    priority_class: null,
    placement_reason: null,
    source_session_id: 3,
    current_revision_id: 206,
    created_at: ago(60 * 24 * 3),
    updated_at: ago(60 * 12),
  },
  {
    id: 107,
    title: "Document eval pipeline staging-only constraint",
    status: "done",
    classifications: ["docs"],
    expected_artifact_type: "git-change",
    expected_paths: ["docs/eval-pipeline.md"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-107",
    base_branch: "dev",
    pr_status: "merged",
    pr_url: "https://github.com/MioMarker/healthbite/pull/265",
    queue_rank: null,
    priority_class: null,
    placement_reason: null,
    source_session_id: 1,
    current_revision_id: 207,
    created_at: ago(60 * 24 * 5),
    updated_at: ago(60 * 24 * 4),
  },
  {
    id: 108,
    title: "Fix Sentry error capture on production builds",
    status: "ready-for-review",
    classifications: ["bug-fix"],
    expected_artifact_type: "git-change",
    expected_paths: ["src/lib/sentry.ts"],
    git_repository_ref: "MioMarker/healthbite",
    git_branch: "major/brief-108",
    base_branch: "dev",
    pr_status: "open",
    pr_url: "https://github.com/MioMarker/healthbite/pull/272",
    queue_rank: 15,
    priority_class: null,
    placement_reason: null,
    source_session_id: 2,
    current_revision_id: 208,
    created_at: ago(60 * 24),
    updated_at: ago(45),
  },
];

const REVISIONS_BY_BRIEF: Record<number, BriefContentRevision[]> = {
  101: [
    {
      id: 201,
      brief_id: 101,
      revision_number: 1,
      content_md:
        "# Meal report empty-state polish\n\n## Acceptance Criteria\n- Empty state shows friendly illustration + CTA.\n- CTA opens log-meal flow.\n\n## Scope Boundaries\n- UI only; no backend writes.\n\n## Expected Paths\n- src/components/meals/**\n- src/hooks/usePendingMealsStore.ts\n",
      author_actor: "human:jonathan",
      reason: "initial-revision",
      created_at: ago(60 * 24),
    },
  ],
  102: [
    {
      id: 202,
      brief_id: 102,
      revision_number: 1,
      content_md: "# Fix submitMealAsync race\n\nDouble-submit fires when network is slow. Acceptance: cannot submit twice within 5s.",
      author_actor: "human:paul",
      reason: "initial-revision",
      created_at: ago(60 * 6),
    },
  ],
  103: [
    {
      id: 203,
      brief_id: 103,
      revision_number: 2,
      content_md: "# MealReportsView v2 — chart polish (rev 2)\n\nAddressed reviewer feedback on color tokens.",
      author_actor: "agent:tachikoma",
      reason: "requested-changes-from-reviewer",
      created_at: ago(60 * 6),
    },
    {
      id: 1203,
      brief_id: 103,
      revision_number: 1,
      content_md: "# MealReportsView v2 — chart polish (rev 1)\n\nInitial revision.",
      author_actor: "human:jonathan",
      reason: "initial-revision",
      created_at: ago(60 * 48),
    },
  ],
};

const RUNS_BY_BRIEF: Record<number, Run[]> = {
  102: [
    {
      id: 5001,
      brief_id: 102,
      purpose: "execute",
      outcome: "running",
      cancellation_reason: null,
      shell_id: "shell-A",
      started_against_revision_id: 202,
      claimed_at: ago(20),
      lease_expires_at: ago(-5),
      heartbeat_at: ago(0.5),
      sandbox_ref: "sandbox-bd71",
      inspected_run_id: null,
      started_at: ago(20),
      ended_at: null,
      num_turns: null,
      duration_ms: null,
      final_text: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      tachikoma_event_sequence: 0,
    },
  ],
  103: [
    {
      id: 5002,
      brief_id: 103,
      purpose: "execute",
      outcome: "succeeded",
      cancellation_reason: null,
      shell_id: "shell-B",
      started_against_revision_id: 203,
      claimed_at: ago(180),
      lease_expires_at: ago(120),
      heartbeat_at: ago(125),
      sandbox_ref: "sandbox-aa31",
      inspected_run_id: null,
      started_at: ago(180),
      ended_at: ago(115),
      num_turns: 12,
      duration_ms: 65000,
      final_text: "Implementer phase complete. PR opened.",
      input_tokens: 9,
      output_tokens: 1356,
      cache_read_tokens: 268058,
      cache_write_tokens: 25197,
      tachikoma_event_sequence: 64,
    },
    {
      id: 5003,
      brief_id: 103,
      purpose: "review",
      outcome: "succeeded",
      cancellation_reason: null,
      shell_id: "shell-B",
      started_against_revision_id: 203,
      claimed_at: ago(110),
      lease_expires_at: ago(80),
      heartbeat_at: ago(90),
      sandbox_ref: "sandbox-aa31",
      inspected_run_id: null,
      started_at: ago(110),
      ended_at: ago(85),
      num_turns: 6,
      duration_ms: 28000,
      final_text: "Reviewer phase complete. status=pass",
      input_tokens: 5,
      output_tokens: 420,
      cache_read_tokens: 154000,
      cache_write_tokens: 12000,
      tachikoma_event_sequence: 32,
    },
  ],
};

const VERIFICATION_BY_RUN: Record<number, VerificationResult[]> = {
  5002: [
    {
      id: 7001,
      run_id: 5002,
      check_name: "tsc-noemit",
      outcome: "pass",
      required: true,
      requiredness_source: "artifact-type-policy",
      payload: { duration_ms: 14210 },
      created_at: ago(120),
    },
    {
      id: 7002,
      run_id: 5002,
      check_name: "tests",
      outcome: "pass",
      required: true,
      requiredness_source: "artifact-type-policy",
      payload: { suite: "vitest", passed: 142 },
      created_at: ago(118),
    },
    {
      id: 7003,
      run_id: 5002,
      check_name: "eval-gate",
      outcome: "skipped",
      required: false,
      requiredness_source: "artifact-type-policy",
      payload: { reason: "no eval paths touched" },
      created_at: ago(116),
    },
  ],
  5003: [
    {
      id: 7004,
      run_id: 5003,
      check_name: "reviewer-tachikoma",
      outcome: "pass",
      required: false,
      requiredness_source: "artifact-type-policy",
      payload: { comment_count: 3 },
      created_at: ago(86),
    },
  ],
};

const ARTIFACTS_BY_BRIEF: Record<number, BriefArtifact[]> = {
  103: [
    {
      id: 9001,
      brief_id: 103,
      run_id: 5002,
      artifact_type: "git-change",
      external_ref: "https://github.com/MioMarker/healthbite/pull/271",
      payload: { base_sha: "abc123", head_sha: "def456", pr_number: 271 },
      created_at: ago(115),
    },
  ],
  108: [
    {
      id: 9002,
      brief_id: 108,
      run_id: null,
      artifact_type: "git-change",
      external_ref: "https://github.com/MioMarker/healthbite/pull/272",
      payload: { pr_number: 272 },
      created_at: ago(45),
    },
  ],
};

const EVENTS_BY_BRIEF: Record<number, MajorEvent[]> = {
  101: [
    {
      id: 11001,
      brief_id: 101,
      run_id: null,
      type: "brief-created",
      actor: "human:jonathan",
      payload: {},
      idempotency_key: "brief-created-101",
      created_at: ago(60 * 24),
    },
    {
      id: 11002,
      brief_id: 101,
      run_id: null,
      type: "status-transitioned",
      actor: "major:auto-triage",
      payload: { from: "ready-for-triage", to: "ready-for-agent" },
      idempotency_key: "status-transitioned-101-ready-for-agent",
      created_at: ago(60 * 23),
    },
  ],
  103: [
    {
      id: 11003,
      brief_id: 103,
      run_id: null,
      type: "brief-created",
      actor: "human:jonathan",
      payload: {},
      idempotency_key: "brief-created-103",
      created_at: ago(60 * 48),
    },
    {
      id: 11004,
      brief_id: 103,
      run_id: 5002,
      type: "run-started",
      actor: "shell:shell-B",
      payload: { purpose: "execute" },
      idempotency_key: "run-started-5002",
      created_at: ago(180),
    },
    {
      id: 11005,
      brief_id: 103,
      run_id: 5002,
      type: "run-ended",
      actor: "shell:shell-B",
      payload: { outcome: "succeeded" },
      idempotency_key: "run-ended-5002",
      created_at: ago(115),
    },
    {
      id: 11006,
      brief_id: 103,
      run_id: 5002,
      type: "artifact-produced",
      actor: "shell:shell-B",
      payload: { artifact_type: "git-change", pr_number: 271 },
      idempotency_key: "artifact-produced-9001",
      created_at: ago(115),
    },
    {
      id: 11007,
      brief_id: 103,
      run_id: null,
      type: "status-transitioned",
      actor: "shell:shell-B",
      payload: { from: "agent-running", to: "ready-for-review" },
      idempotency_key: "status-transitioned-103-ready-for-review",
      created_at: ago(115),
    },
  ],
};

const RELATIONSHIPS_BY_BRIEF: Record<number, Array<BriefRelationship & { related_brief: Pick<Brief, "id" | "status"> }>> = {
  103: [
    {
      id: 13001,
      parent_id: 100,
      child_id: 103,
      type: "parent-child",
      parent_review_requirement: "required",
      excluded_reason: null,
      excluded_by_actor: null,
      created_at: ago(60 * 48),
      related_brief: { id: 100, status: "ready-for-review" },
    },
  ],
};

export function listMockBriefs(filters: { status?: string; classification?: string } = {}): Brief[] {
  let briefs = [...MOCK_BRIEFS];
  if (filters.status) briefs = briefs.filter((b) => b.status === filters.status);
  if (filters.classification) {
    briefs = briefs.filter((b) =>
      b.classifications.includes(filters.classification as never),
    );
  }
  return briefs.sort((a, b) => {
    const ar = a.queue_rank ?? Number.MAX_SAFE_INTEGER;
    const br = b.queue_rank ?? Number.MAX_SAFE_INTEGER;
    return ar - br;
  });
}

// Mirrors the `major-list-briefs` paging contract: clamp limit to 1–200
// (default 50), offset 0+, and return the full filtered count as `total`
// alongside the requested window.
export function listMockBriefsPaged(
  filters: { status?: string; classification?: string } = {},
  page: { limit?: number; offset?: number } = {},
): { briefs: Brief[]; total: number } {
  const all = listMockBriefs(filters);
  const limit = Math.min(200, Math.max(1, page.limit ?? 50));
  const offset = Math.max(0, page.offset ?? 0);
  return { briefs: all.slice(offset, offset + limit), total: all.length };
}

export function getMockBrief(id: number): BriefDetail | null {
  const brief = MOCK_BRIEFS.find((b) => b.id === id);
  if (!brief) return null;
  const revisions = REVISIONS_BY_BRIEF[id] ?? [];
  return {
    ...brief,
    current_revision: revisions.find((r) => r.id === brief.current_revision_id) ?? null,
    revisions,
    events: EVENTS_BY_BRIEF[id] ?? [],
    runs: RUNS_BY_BRIEF[id] ?? [],
    verification_results: (RUNS_BY_BRIEF[id] ?? []).flatMap(
      (r) => VERIFICATION_BY_RUN[r.id] ?? [],
    ),
    artifacts: ARTIFACTS_BY_BRIEF[id] ?? [],
    telemetry_records: [],
    relationships: RELATIONSHIPS_BY_BRIEF[id] ?? [],
  };
}

export function listMockQaBriefs(): Brief[] {
  return MOCK_BRIEFS.filter((b) => b.status === "ready-for-review");
}

export const MOCK_USED_NOW = now;
