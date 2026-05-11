// Typed wrapper for the `major-merge-pr` edge function (ADR 016/017).
//
// Mirrors `_shared/schemas/merge-pr.ts` on the function side. The schema
// itself lives behind a Deno-only import on the function side; we redeclare
// the closed-set shape here so the UI compiles standalone without dragging
// the Deno runtime into the Next bundle.

import { USE_MOCK, majorFetch } from "@/lib/api/client";

export const MERGE_ATTEMPT_FAILED_REASONS = [
  "approval-rejected",
  "merge-rejected",
  "merge-conflict",
  "unknown",
] as const;

export type MergeAttemptFailedReason =
  (typeof MERGE_ATTEMPT_FAILED_REASONS)[number];

export interface GithubResponseSummary {
  status: number;
  message: string;
}

export interface MergePrSuccess {
  outcome: "merged";
  pr_url: string;
}

export interface MergePrBlocked {
  outcome: "blocked";
  reason: MergeAttemptFailedReason;
  github_response: GithubResponseSummary;
}

export type MergePrResponse = MergePrSuccess | MergePrBlocked;

// Deterministic mock: 7 out of every 10 calls return `merged`; the 3rd, 6th,
// and 9th return a `blocked` reason that cycles through the closed set. This
// is enough to exercise the per-repo circuit breaker in mock mode without
// any backend running.
function mockMergePr(briefId: number): MergePrResponse {
  const slot = briefId % 10;
  if (slot === 3) {
    return {
      outcome: "blocked",
      reason: "approval-rejected",
      github_response: { status: 422, message: "mock: approval rejected" },
    };
  }
  if (slot === 6) {
    return {
      outcome: "blocked",
      reason: "merge-conflict",
      github_response: { status: 405, message: "mock: not mergeable" },
    };
  }
  if (slot === 9) {
    return {
      outcome: "blocked",
      reason: "merge-rejected",
      github_response: { status: 405, message: "mock: merge rejected" },
    };
  }
  return {
    outcome: "merged",
    pr_url: `https://github.com/MioMarker/healthbite/pull/${briefId}`,
  };
}

export async function mergePr(
  briefId: number,
  authToken?: string,
): Promise<MergePrResponse> {
  if (USE_MOCK) {
    // Honour the loop's expectation of network-shaped latency so the panel's
    // progress UI gets a chance to flush between iterations.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return mockMergePr(briefId);
  }
  return majorFetch<MergePrResponse>("major-merge-pr", {
    method: "POST",
    body: { briefId },
    authToken,
  });
}

const REASON_LABELS: Record<MergeAttemptFailedReason, string> = {
  "approval-rejected": "GitHub rejected the auto-approval (likely a branch rule).",
  "merge-rejected": "GitHub rejected the merge (branch protections or CI gate).",
  "merge-conflict": "PR has a merge conflict with the base branch.",
  unknown: "Unknown failure — check the event log for details.",
};

export function describeMergeFailureReason(
  reason: MergeAttemptFailedReason,
): string {
  return REASON_LABELS[reason];
}
