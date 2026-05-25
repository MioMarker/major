// shell/ci-helpers.test.ts — unit tests for the ci-wait phase helpers.
//
// Covers the three bug-fix behaviors (incident: MioMarker/healthbite retry
// storm):
//   1. Poll cap (ADR 017): pending re-polls bounded to CI_MAX_POLLS, then SKIP.
//   2. Skip-on-unreadable: a permission-denied / statusCheckRollup 403 / auth
//      failure classifies as `unreadable` → advisory SKIP, never a retry and
//      never a `fail`.
//   3. Correct classification of pass / fail / pending / no-checks.
//
// Pure-function fixture tests — no network, no DB, no subprocess.
//
// Run: node --test --require ts-node/register ci-helpers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGhChecks,
  decideCiPoll,
  isUnreadableChecksError,
  isNoChecksConfigured,
  CI_CHECK_CLASS,
  CI_OUTCOME,
  CI_MAX_POLLS,
  CI_POLL_INTERVAL_MS,
  type CiOutcome,
} from "./ci-helpers";

// ────────────────────────────────────────────────────────────────────
// Budget constants reflect ADR 017 (~4 reads / ~90s)
// ────────────────────────────────────────────────────────────────────

test("ADR 017: poll budget is ~4 reads / ~90s", () => {
  assert.equal(CI_MAX_POLLS, 3, "maxPolls default per ADR 017");
  assert.equal(CI_POLL_INTERVAL_MS, 30_000, "pollIntervalMs default per ADR 017");
  // Worst case: 1 initial read + CI_MAX_POLLS re-polls = 4 reads;
  // wall time = CI_MAX_POLLS * interval = 90s.
  assert.equal(1 + CI_MAX_POLLS, 4);
  assert.equal(CI_MAX_POLLS * CI_POLL_INTERVAL_MS, 90_000);
});

// ────────────────────────────────────────────────────────────────────
// isUnreadableChecksError — permission-denied detection (bug #3)
// ────────────────────────────────────────────────────────────────────

test("isUnreadableChecksError: matches the observed statusCheckRollup 403", () => {
  // The exact denial from the incident logs.
  const stderr =
    "GraphQL: Resource not accessible by personal access token " +
    "(node.statusCheckRollup.nodes.0.commit.statusCheckRollup)";
  assert.equal(isUnreadableChecksError(stderr), true);
});

test("isUnreadableChecksError: matches generic 'resource not accessible' (case-insensitive)", () => {
  assert.equal(isUnreadableChecksError("Resource Not Accessible By Personal Access Token"), true);
  assert.equal(isUnreadableChecksError("resource not accessible by integration"), true);
});

test("isUnreadableChecksError: matches HTTP 401/403 on the checks read", () => {
  assert.equal(isUnreadableChecksError("gh: HTTP 403: Forbidden"), true);
  assert.equal(isUnreadableChecksError("gh: HTTP 401"), true);
});

test("isUnreadableChecksError: does NOT match a benign 'no checks reported' stderr", () => {
  assert.equal(isUnreadableChecksError("no checks reported on the 'main' branch"), false);
});

test("isUnreadableChecksError: does NOT match an empty stderr", () => {
  assert.equal(isUnreadableChecksError(""), false);
});

// ────────────────────────────────────────────────────────────────────
// isNoChecksConfigured
// ────────────────────────────────────────────────────────────────────

test("isNoChecksConfigured: matches gh's 'no checks reported' phrasing", () => {
  assert.equal(isNoChecksConfigured("no checks reported on the 'major/brief-12' branch"), true);
  assert.equal(isNoChecksConfigured("No Checks Reported"), true);
});

test("isNoChecksConfigured: does not match a permission error", () => {
  assert.equal(isNoChecksConfigured("Resource not accessible by personal access token"), false);
});

// ────────────────────────────────────────────────────────────────────
// classifyGhChecks — single-invocation classification
// ────────────────────────────────────────────────────────────────────

test("classifyGhChecks: exit 0 with rows → pass", () => {
  const klass = classifyGhChecks({
    exitCode: 0,
    stdout: "build\tpass\t1m2s\thttps://github.com/...\n",
    stderr: "",
  });
  assert.equal(klass, CI_CHECK_CLASS.pass);
});

test("classifyGhChecks: exit 8 → pending (re-pollable)", () => {
  const klass = classifyGhChecks({
    exitCode: 8,
    stdout: "build\tpending\t0\thttps://github.com/...\n",
    stderr: "",
  });
  assert.equal(klass, CI_CHECK_CLASS.pending);
});

test("classifyGhChecks: exit 1 with failing checks → fail", () => {
  const klass = classifyGhChecks({
    exitCode: 1,
    stdout: "test\tfail\t30s\thttps://github.com/...\n",
    stderr: "",
  });
  assert.equal(klass, CI_CHECK_CLASS.fail);
});

test("classifyGhChecks: exit 2 (cancelled) → fail", () => {
  const klass = classifyGhChecks({ exitCode: 2, stdout: "", stderr: "" });
  assert.equal(klass, CI_CHECK_CLASS.fail);
});

test("classifyGhChecks: 'no checks reported' stderr → no-checks (advisory)", () => {
  const klass = classifyGhChecks({
    exitCode: 1,
    stdout: "",
    stderr: "no checks reported on the 'major/brief-9' branch",
  });
  assert.equal(klass, CI_CHECK_CLASS.noChecks);
});

test("classifyGhChecks: exit 0 with empty stdout → no-checks (not a vacuous pass)", () => {
  const klass = classifyGhChecks({ exitCode: 0, stdout: "   \n", stderr: "" });
  assert.equal(klass, CI_CHECK_CLASS.noChecks);
});

test("classifyGhChecks: statusCheckRollup 403 → unreadable (NOT fail, even though exit 1)", () => {
  // This is the incident case: gh exits non-zero with the GraphQL denial. The
  // prior code's catch-all 'keep polling' branch burned 20 minutes; the new
  // classifier marks it unreadable so the caller skips immediately.
  const klass = classifyGhChecks({
    exitCode: 1,
    stdout: "",
    stderr:
      "GraphQL: Resource not accessible by personal access token " +
      "(node.statusCheckRollup.nodes.0.commit.statusCheckRollup)",
  });
  assert.equal(klass, CI_CHECK_CLASS.unreadable);
});

test("classifyGhChecks: exit 4 (auth required) → unreadable", () => {
  const klass = classifyGhChecks({ exitCode: 4, stdout: "", stderr: "authentication required" });
  assert.equal(klass, CI_CHECK_CLASS.unreadable);
});

test("classifyGhChecks: HTTP 403 with exit 1 → unreadable (precedence over fail)", () => {
  const klass = classifyGhChecks({ exitCode: 1, stdout: "", stderr: "gh: HTTP 403: Forbidden" });
  assert.equal(klass, CI_CHECK_CLASS.unreadable);
});

test("classifyGhChecks: unknown non-zero exit with no telling stderr → pending (bounded retry)", () => {
  // A transient gh/network blip: re-poll within budget, never fail.
  const klass = classifyGhChecks({ exitCode: 7, stdout: "", stderr: "some transient blip" });
  assert.equal(klass, CI_CHECK_CLASS.pending);
});

// ────────────────────────────────────────────────────────────────────
// decideCiPoll — poll-budget decision (bug #2: cap)
// ────────────────────────────────────────────────────────────────────

test("decideCiPoll: pass → resolve pass", () => {
  const d = decideCiPoll(CI_CHECK_CLASS.pass, 0);
  assert.equal(d.kind, "resolve");
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.pass);
});

test("decideCiPoll: fail → resolve fail", () => {
  const d = decideCiPoll(CI_CHECK_CLASS.fail, 0);
  assert.equal(d.kind, "resolve");
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.fail);
});

test("decideCiPoll: no-checks → resolve skipped", () => {
  const d = decideCiPoll(CI_CHECK_CLASS.noChecks, 0);
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.skipped);
});

test("decideCiPoll: unreadable → resolve skipped (never poll)", () => {
  // Critical: even at pollsSoFar=0 an unreadable result resolves to skipped,
  // it does NOT enter the poll loop. This is what kills the retry storm.
  const d = decideCiPoll(CI_CHECK_CLASS.unreadable, 0);
  assert.equal(d.kind, "resolve");
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.skipped);
});

test("decideCiPoll: pending below cap → poll", () => {
  assert.equal(decideCiPoll(CI_CHECK_CLASS.pending, 0).kind, "poll");
  assert.equal(decideCiPoll(CI_CHECK_CLASS.pending, CI_MAX_POLLS - 1).kind, "poll");
});

test("decideCiPoll: pending AT cap → resolve skipped (advisory, not fail)", () => {
  const d = decideCiPoll(CI_CHECK_CLASS.pending, CI_MAX_POLLS);
  assert.equal(d.kind, "resolve");
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.skipped);
});

test("decideCiPoll: pending ABOVE cap → resolve skipped", () => {
  const d = decideCiPoll(CI_CHECK_CLASS.pending, CI_MAX_POLLS + 5);
  assert.equal(d.kind === "resolve" && d.outcome, CI_OUTCOME.skipped);
});

// ────────────────────────────────────────────────────────────────────
// End-to-end poll-budget simulation (bug #2: no 20-minute loop)
// ────────────────────────────────────────────────────────────────────

test("poll-budget: persistently-pending CI resolves SKIPPED after exactly 1 + CI_MAX_POLLS reads", () => {
  // Simulate the waitForCI loop with a check that never leaves pending.
  let reads = 0;
  let outcome: CiOutcome = CI_OUTCOME.skipped;
  for (let pollsSoFar = 0; ; pollsSoFar += 1) {
    reads += 1; // one gh read per iteration
    const klass = classifyGhChecks({ exitCode: 8, stdout: "ci\tpending\t0\t-\n", stderr: "" });
    const d = decideCiPoll(klass, pollsSoFar, CI_MAX_POLLS);
    if (d.kind === "resolve") {
      outcome = d.outcome;
      break;
    }
  }
  assert.equal(reads, 1 + CI_MAX_POLLS, "must read exactly 1 + maxPolls times, not loop for 20 min");
  assert.equal(outcome, CI_OUTCOME.skipped, "exhausted pending budget is an advisory skip, not a fail");
});

test("poll-budget: statusCheckRollup 403 resolves SKIPPED on the FIRST read (no retries)", () => {
  // The incident's exact failure: must skip immediately, never re-poll.
  let reads = 0;
  let outcome: CiOutcome = CI_OUTCOME.fail;
  for (let pollsSoFar = 0; ; pollsSoFar += 1) {
    reads += 1;
    const klass = classifyGhChecks({
      exitCode: 1,
      stdout: "",
      stderr:
        "GraphQL: Resource not accessible by personal access token " +
        "(node.statusCheckRollup.nodes.0.commit.statusCheckRollup)",
    });
    const d = decideCiPoll(klass, pollsSoFar, CI_MAX_POLLS);
    if (d.kind === "resolve") {
      outcome = d.outcome;
      break;
    }
  }
  assert.equal(reads, 1, "permission denial must skip on the first read — zero retries");
  assert.equal(outcome, CI_OUTCOME.skipped, "permission denial is an advisory skip, not a fail");
});

test("poll-budget: CI that finishes green on the 2nd read resolves pass (no over-polling)", () => {
  const states = [
    { exitCode: 8, stdout: "ci\tpending\t0\t-\n", stderr: "" }, // 1st read: pending
    { exitCode: 0, stdout: "ci\tpass\t1m\t-\n", stderr: "" }, // 2nd read: pass
  ];
  let reads = 0;
  let outcome: CiOutcome = CI_OUTCOME.skipped;
  for (let pollsSoFar = 0; ; pollsSoFar += 1) {
    const capture = states[Math.min(reads, states.length - 1)];
    reads += 1;
    const d = decideCiPoll(classifyGhChecks(capture), pollsSoFar, CI_MAX_POLLS);
    if (d.kind === "resolve") {
      outcome = d.outcome;
      break;
    }
  }
  assert.equal(reads, 2, "should resolve as soon as CI goes green");
  assert.equal(outcome, CI_OUTCOME.pass);
});
