// supabase/functions/_shared/schemas/merge-pr.ts
//
// Zod schemas for major-merge-pr (Mode 1 backend, ADR 016 / 017).
//
// Algorithm (b) — approve + squash-merge, no pre-flight. The pre-flight
// reasons enumerated in ADR 017 (`draft`, `ci-red`, `ci-not-done`,
// `unresolved-review-threads`) are deferred to that ADR's later
// implementation and intentionally absent from MergeAttemptFailedReason
// below.

import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

export const MergePrRequest = z.object({
  briefId: z.number().int().positive(),
});
export type MergePrRequest = z.infer<typeof MergePrRequest>;

// Closed-set reason codes for the `status-transitioned` event payload
// written on `ready-for-review|merge-blocked → merge-blocked`. Per
// ADR 016 § "Event payload shape" — restricted to algorithm (b) reasons.
export const MERGE_ATTEMPT_FAILED_REASONS = [
  "approval-rejected",
  "merge-rejected",
  "merge-conflict",
  "unknown",
] as const;
export const MergeAttemptFailedReason = z.enum(MERGE_ATTEMPT_FAILED_REASONS);
export type MergeAttemptFailedReason = z.infer<typeof MergeAttemptFailedReason>;

// GitHub response echo carried in the event payload + the function response
// body. Shape mirrors what the function captures from a non-2xx GitHub call.
export const GithubResponseSummary = z.object({
  status: z.number().int(),
  message: z.string(),
});
export type GithubResponseSummary = z.infer<typeof GithubResponseSummary>;

export const MergePrSuccessResponse = z.object({
  outcome: z.literal("merged"),
  pr_url: z.string(),
});
export type MergePrSuccessResponse = z.infer<typeof MergePrSuccessResponse>;

export const MergePrBlockedResponse = z.object({
  outcome: z.literal("blocked"),
  reason: MergeAttemptFailedReason,
  github_response: GithubResponseSummary,
});
export type MergePrBlockedResponse = z.infer<typeof MergePrBlockedResponse>;

export const MergePrResponse = z.discriminatedUnion("outcome", [
  MergePrSuccessResponse,
  MergePrBlockedResponse,
]);
export type MergePrResponse = z.infer<typeof MergePrResponse>;
