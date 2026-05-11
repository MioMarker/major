// Mode 1 (tab-bound "Merge all ready-for-review") — closed-set types for the
// orchestration loop and the panel that renders it. Lifecycle authority for
// Briefs still belongs to the Cyberbrain; this module models *the loop's own
// state* as it walks per-PR calls to `major-merge-pr`.

import type { Brief } from "@/lib/types";
import type { MergeAttemptFailedReason } from "@/lib/api/merge-pr";

// Each Brief lands in exactly one tier. Multi-classification Briefs land in
// the highest-risk tier they carry. Tier 4 is the catch-all for Briefs whose
// classifications don't match any of the configured tiers (e.g. `parent`,
// `epic`, or none at all). They merge last so the safer Briefs go first.
export const TIERS = [1, 2, 3, 4] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  1: "docs",
  2: "bug-fix / refactor",
  3: "feature",
  4: "unclassified",
};

// Reasons a Brief was skipped or failed to merge during the run. Echoes the
// closed-set from the edge function plus orchestration-only reasons
// (`repo-suspended` from the circuit breaker, `run-cancelled` from Stop).
export const SKIP_REASONS = [
  "approval-rejected",
  "merge-rejected",
  "merge-conflict",
  "unknown",
  "repo-suspended",
  "run-cancelled",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// A Brief paired with the tier-sort metadata, computed once at run start.
export interface BriefForMerge {
  brief: Brief;
  tier: Tier;
  prNumber: number | null;
  repo: string;
}

export interface MergedEntry {
  briefId: number;
  briefTitle: string | null;
  prUrl: string;
  repo: string;
}

export interface SkippedEntry {
  briefId: number;
  briefTitle: string | null;
  reason: SkipReason;
  // Surfaced verbatim from `github_response.message` when the edge function
  // returned `blocked`. Absent on orchestration-only reasons.
  detail: string | null;
  repo: string;
}

// Runtime state of a single Mode 1 run. All fields are immutable — the loop
// produces a new state object per progress tick so React re-renders cleanly.
export interface MergeRunState {
  total: number;
  queue: ReadonlyArray<BriefForMerge>;
  merged: ReadonlyArray<MergedEntry>;
  skipped: ReadonlyArray<SkippedEntry>;
  // Per-repo running count of consecutive blocked outcomes. Resets on the
  // next successful merge in the same repo. Used by the circuit breaker.
  consecutiveFailures: Readonly<Record<string, number>>;
  suspendedRepos: ReadonlyArray<string>;
  currentIndex: number;
  currentBriefId: number | null;
  cancelled: boolean;
  done: boolean;
}

// MergeAttemptFailedReason is re-exported for module consumers that operate
// in MergeRunState terms but still need to render reason text.
export type { MergeAttemptFailedReason };
