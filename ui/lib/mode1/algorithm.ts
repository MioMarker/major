// Mode 1 orchestration loop. Pure, async, immutable state. Yields control
// between PRs (one `await` per per-PR call) so the panel can re-render and
// the user can press Stop. The loop never queries the Cyberbrain itself —
// the panel snapshots the eligible Briefs at open time and hands them in.

import type { Brief, BriefClassification } from "@/lib/types";
import type { MergePrResponse } from "@/lib/api/merge-pr";
import type {
  BriefForMerge,
  MergedEntry,
  MergeRunState,
  SkipReason,
  SkippedEntry,
  Tier,
} from "@/lib/mode1/types";

const CIRCUIT_BREAKER_THRESHOLD = 3;

// Tier assignment per the Mode 1 spec:
//   tier 1 = `docs` and no higher-risk class
//   tier 2 = `bug-fix` or `refactor`
//   tier 3 = `feature`
//   tier 4 = catch-all for Briefs that don't carry any of the above
//            (e.g. `parent`, `epic`, or none). They merge last on the
//            "least known risk → defer" principle.
export function classifyTier(
  classifications: ReadonlyArray<BriefClassification>,
): Tier {
  const set = new Set(classifications);
  if (set.has("feature")) return 3;
  if (set.has("bug-fix") || set.has("refactor")) return 2;
  if (set.has("docs")) return 1;
  return 4;
}

// `https://github.com/owner/repo/pull/NNN` → NNN. Returns null for unparsable
// URLs (the tier-sort secondary key falls back to brief id when null).
export function extractPrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  try {
    const u = new URL(prUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("pull");
    if (idx === -1 || idx + 1 >= parts.length) return null;
    const n = Number(parts[idx + 1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function deriveRepo(brief: Brief): string {
  return brief.git_repository_ref ?? "unknown";
}

// Stable order: by tier ascending, then PR number ascending (Briefs without
// a PR number sink to the bottom of their tier so they don't block PRs that
// can actually be merged). Brief id is the final tiebreaker for determinism.
export function sortBriefsForMerge(
  briefs: ReadonlyArray<Brief>,
): ReadonlyArray<BriefForMerge> {
  const decorated: BriefForMerge[] = briefs.map((brief) => ({
    brief,
    tier: classifyTier(brief.classifications),
    prNumber: extractPrNumber(brief.pr_url),
    repo: deriveRepo(brief),
  }));
  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const aPr = a.prNumber ?? Number.MAX_SAFE_INTEGER;
    const bPr = b.prNumber ?? Number.MAX_SAFE_INTEGER;
    if (aPr !== bPr) return aPr - bPr;
    return a.brief.id - b.brief.id;
  });
  return decorated;
}

function createInitialState(
  queue: ReadonlyArray<BriefForMerge>,
): MergeRunState {
  return {
    total: queue.length,
    queue,
    merged: [],
    skipped: [],
    consecutiveFailures: {},
    suspendedRepos: [],
    currentIndex: -1,
    currentBriefId: null,
    cancelled: false,
    done: false,
  };
}

function recordMerged(
  state: MergeRunState,
  entry: BriefForMerge,
  prUrl: string,
): MergeRunState {
  const merged: MergedEntry = {
    briefId: entry.brief.id,
    briefTitle: entry.brief.title,
    prUrl,
    repo: entry.repo,
  };
  const next = { ...state.consecutiveFailures, [entry.repo]: 0 };
  return {
    ...state,
    merged: [...state.merged, merged],
    consecutiveFailures: next,
  };
}

function recordSkipped(
  state: MergeRunState,
  entry: BriefForMerge,
  reason: SkipReason,
  detail: string | null,
): MergeRunState {
  const skipped: SkippedEntry = {
    briefId: entry.brief.id,
    briefTitle: entry.brief.title,
    reason,
    detail,
    repo: entry.repo,
  };
  return { ...state, skipped: [...state.skipped, skipped] };
}

function bumpFailure(state: MergeRunState, repo: string): MergeRunState {
  const nextCount = (state.consecutiveFailures[repo] ?? 0) + 1;
  const consecutiveFailures = { ...state.consecutiveFailures, [repo]: nextCount };
  const suspendedRepos =
    nextCount >= CIRCUIT_BREAKER_THRESHOLD && !state.suspendedRepos.includes(repo)
      ? [...state.suspendedRepos, repo]
      : state.suspendedRepos;
  return { ...state, consecutiveFailures, suspendedRepos };
}

export interface RunMergeAllOptions {
  briefs: ReadonlyArray<Brief>;
  // Returns true once the user has pressed Stop. The loop checks this
  // before starting each next per-PR call. The in-flight call is allowed
  // to complete so its outcome stays consistent with the backend.
  isCancelled: () => boolean;
  // Per-PR call. Implementations must not throw on `blocked` outcomes —
  // those come back through the `MergePrResponse` discriminated union.
  // A thrown error here is treated as an `unknown` skip + a circuit-breaker
  // tick, matching the closed-set reason set for the orchestration loop.
  merge: (briefId: number) => Promise<MergePrResponse>;
  // Called with a fresh state object on every transition so React can
  // re-render. The callback is invoked synchronously after the state
  // change, before the loop yields to await the next per-PR call.
  onProgress: (state: MergeRunState) => void;
}

export async function runMergeAll(
  options: RunMergeAllOptions,
): Promise<MergeRunState> {
  const queue = sortBriefsForMerge(options.briefs);
  let state = createInitialState(queue);
  options.onProgress(state);

  for (let i = 0; i < queue.length; i++) {
    if (options.isCancelled()) {
      state = { ...state, cancelled: true };
      break;
    }
    const entry = queue[i];

    if (state.suspendedRepos.includes(entry.repo)) {
      state = recordSkipped(state, entry, "repo-suspended", null);
      options.onProgress(state);
      continue;
    }

    state = { ...state, currentIndex: i, currentBriefId: entry.brief.id };
    options.onProgress(state);

    let response: MergePrResponse | null = null;
    let thrown: string | null = null;
    try {
      response = await options.merge(entry.brief.id);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    if (thrown !== null) {
      state = recordSkipped(state, entry, "unknown", thrown);
      state = bumpFailure(state, entry.repo);
    } else if (response && response.outcome === "merged") {
      state = recordMerged(state, entry, response.pr_url);
    } else if (response && response.outcome === "blocked") {
      state = recordSkipped(
        state,
        entry,
        response.reason,
        response.github_response.message,
      );
      state = bumpFailure(state, entry.repo);
    }

    options.onProgress(state);
  }

  state = { ...state, done: true, currentBriefId: null };
  options.onProgress(state);
  return state;
}
