// shell/ci-helpers.ts — pure helpers for the post-PR ci-wait phase.
//
// Extracted from main.ts so the polling/classification logic can be
// unit-tested without importing the daemon entry point (which boots on
// import). No I/O, no HTTP, no subprocess, no side effects.
//
// Background (ADR 017 — Mode 1 pre-flight; the same poll discipline applies
// to the Shell's post-PR ci-wait): ci-wait reads the PR's CI rollup and
// classifies it. CI on GitHub continues regardless of what the Shell reads —
// the read is ADVISORY. So a read that the Shell's token cannot perform must
// SKIP the phase, never block or loop on it.
//
// The read shells out to plain `gh pr checks <n> -R <repo>` (no `--json`).
// The plain variant resolves CI state via the REST checks / check-runs
// endpoint, which the `major-shell-bot` fine-grained PAT can read with
// `Actions: Read`. The `--json bucket` variant instead forces a GraphQL
// query that traverses `pullRequest.statusCheckRollup.nodes[].commit.
// statusCheckRollup`; reading the *commit's* status-check rollup needs
// `Commit statuses: Read` / `Checks: Read`, which the bot PAT lacks, so it
// returns `Resource not accessible by personal access token`. That denial
// is the root cause of the observed retry storm — see runbook §1.7.1.

// ────────────────────────────────────────────────────────────────────
// Poll-budget constants (ADR 017)
// ────────────────────────────────────────────────────────────────────

/** Interval between CI re-polls. ADR 017 default `pollIntervalMs`. */
export const CI_POLL_INTERVAL_MS = 30_000;

/**
 * Maximum number of *re*-polls after the initial read. ADR 017 default
 * `maxPolls = 3`. Worst-case read count is `1 + CI_MAX_POLLS` (~4 reads),
 * worst-case wall time ~`CI_MAX_POLLS * CI_POLL_INTERVAL_MS` (~90s). This
 * replaces the prior 20-minute timeout budget that produced the retry storm.
 */
export const CI_MAX_POLLS = 3;

// ────────────────────────────────────────────────────────────────────
// Result + classification types
// ────────────────────────────────────────────────────────────────────

/** Terminal outcome the ci-wait phase reports as the `ci-rollup` verification. */
export const CI_OUTCOME = {
  pass: "pass",
  fail: "fail",
  skipped: "skipped",
} as const;
export type CiOutcome = (typeof CI_OUTCOME)[keyof typeof CI_OUTCOME];

/**
 * Classification of a single `gh pr checks` invocation. Distinguishes the
 * four cases the caller must treat differently:
 *  - `pass`       — all checks green; resolve pass.
 *  - `fail`       — at least one check failed/cancelled; resolve fail.
 *  - `pending`    — checks still running; a legitimate reason to re-poll.
 *  - `no-checks`  — PR has no CI configured; resolve skipped (advisory).
 *  - `unreadable` — token cannot read CI state (permission denied / auth /
 *                   GraphQL rollup 403); resolve skipped (advisory). NEVER
 *                   re-polled — retrying a permission denial just loops.
 */
export const CI_CHECK_CLASS = {
  pass: "pass",
  fail: "fail",
  pending: "pending",
  noChecks: "no-checks",
  unreadable: "unreadable",
} as const;
export type CiCheckClass = (typeof CI_CHECK_CLASS)[keyof typeof CI_CHECK_CLASS];

/** Raw captured output of a `gh pr checks` invocation. */
export interface GhChecksCapture {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ────────────────────────────────────────────────────────────────────
// Permission / unreadable detection
// ────────────────────────────────────────────────────────────────────

// Signatures that mean "this token cannot read the PR's CI state". Matched
// against stderr (lower-cased). These are advisory-skip, not retryable:
//   - the GraphQL statusCheckRollup 403 the bot PAT triggers
//   - any generic "resource not accessible by personal access token"
//   - HTTP 403 / 401 on the checks read
//   - "must have admin rights" / "not accessible" phrasings
const UNREADABLE_STDERR_SIGNATURES: readonly string[] = [
  "resource not accessible by personal access token",
  "resource not accessible by integration",
  "not accessible by personal access token",
  "statuscheckrollup",
  "http 403",
  "http 401",
  "must have push access",
  "must have admin rights",
] as const;

// "No CI configured" signature. gh exits non-zero with this on stderr when a
// PR has no associated workflow runs.
const NO_CHECKS_STDERR_SIGNATURE = "no checks reported";

// `gh pr checks` documented exit codes (gh help exit-codes + pr checks help):
//   0 — all checks passed
//   1 — generic failure (incl. a failing/cancelled check, OR a hard error)
//   2 — cancelled
//   4 — authentication required
//   8 — checks pending
const GH_EXIT = {
  pass: 0,
  failure: 1,
  cancelled: 2,
  authRequired: 4,
  pending: 8,
} as const;

function lc(s: string): string {
  return s.toLowerCase();
}

/** True if stderr indicates the token cannot read CI state (advisory-skip). */
export function isUnreadableChecksError(stderr: string): boolean {
  const hay = lc(stderr);
  return UNREADABLE_STDERR_SIGNATURES.some((sig) => hay.includes(sig));
}

/** True if stderr indicates the PR simply has no CI configured. */
export function isNoChecksConfigured(stderr: string): boolean {
  return lc(stderr).includes(NO_CHECKS_STDERR_SIGNATURE);
}

// ────────────────────────────────────────────────────────────────────
// Classification of a single `gh pr checks` invocation
// ────────────────────────────────────────────────────────────────────

/**
 * Classify one `gh pr checks` (plain, no `--json`) invocation into a
 * {@link CiCheckClass}. Order matters: permission/auth denials and the
 * "no checks" signal are checked before the exit-code switch, because a
 * permission denial surfaces as a non-zero exit with a telling stderr and
 * must NOT be read as a check failure.
 *
 * Pure: depends only on its argument.
 */
export function classifyGhChecks(capture: GhChecksCapture): CiCheckClass {
  const { exitCode, stdout, stderr } = capture;

  // 1. Token cannot read CI — advisory skip. Highest priority: a 403/401 on
  //    the rollup read can carry exit 1 and would otherwise look like "fail".
  if (isUnreadableChecksError(stderr) || exitCode === GH_EXIT.authRequired) {
    return CI_CHECK_CLASS.unreadable;
  }

  // 2. PR has no CI configured — advisory skip.
  if (isNoChecksConfigured(stderr)) {
    return CI_CHECK_CLASS.noChecks;
  }

  // 3. Documented exit codes for a readable PR.
  switch (exitCode) {
    case GH_EXIT.pending:
      return CI_CHECK_CLASS.pending;
    case GH_EXIT.pass:
      // Exit 0 with empty stdout means gh reported no rows — treat as no-checks
      // rather than a vacuous pass.
      return stdout.trim().length === 0 ? CI_CHECK_CLASS.noChecks : CI_CHECK_CLASS.pass;
    case GH_EXIT.failure:
    case GH_EXIT.cancelled:
      return CI_CHECK_CLASS.fail;
    default:
      // Unknown / transient gh failure with no telling stderr. Treat as
      // pending so it re-polls within the bounded budget; on cap exhaustion
      // the caller resolves skipped (advisory), never fail.
      return CI_CHECK_CLASS.pending;
  }
}

// ────────────────────────────────────────────────────────────────────
// Poll-budget decision
// ────────────────────────────────────────────────────────────────────

/** Whether to continue polling or resolve, after one classified read. */
export type CiPollDecision =
  | { kind: "resolve"; outcome: CiOutcome; reason: string }
  | { kind: "poll" };

/**
 * Decide what to do after one classified `gh pr checks` read.
 *
 * `pollsSoFar` is the number of re-polls already performed (0 on the first
 * read). When the classification is `pending` and the budget is exhausted
 * (`pollsSoFar >= maxPolls`), the phase resolves SKIPPED — ci-wait is
 * advisory, so an unfinished CI rollup must not block or fail the Run.
 *
 * Pure: depends only on its arguments.
 */
export function decideCiPoll(
  klass: CiCheckClass,
  pollsSoFar: number,
  maxPolls: number = CI_MAX_POLLS,
): CiPollDecision {
  switch (klass) {
    case CI_CHECK_CLASS.pass:
      return { kind: "resolve", outcome: CI_OUTCOME.pass, reason: "all CI checks passed" };
    case CI_CHECK_CLASS.fail:
      return { kind: "resolve", outcome: CI_OUTCOME.fail, reason: "one or more CI checks failed" };
    case CI_CHECK_CLASS.noChecks:
      return {
        kind: "resolve",
        outcome: CI_OUTCOME.skipped,
        reason: "no CI checks registered on this PR",
      };
    case CI_CHECK_CLASS.unreadable:
      return {
        kind: "resolve",
        outcome: CI_OUTCOME.skipped,
        reason: "CI checks not readable by Shell token (advisory skip)",
      };
    case CI_CHECK_CLASS.pending:
      if (pollsSoFar >= maxPolls) {
        return {
          kind: "resolve",
          outcome: CI_OUTCOME.skipped,
          reason: `CI still pending after ${maxPolls} polls (advisory skip)`,
        };
      }
      return { kind: "poll" };
  }
}
