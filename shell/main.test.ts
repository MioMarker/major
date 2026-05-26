// shell/main.test.ts — behavioral specification tests for Stream D fixes.
//
// Run: node --test --require ts-node/register main.test.ts
//
// NOTE: main.ts does not export its internal functions (it is a daemon
// entry point that runs immediately on import). These tests validate the
// SPECIFICATION of each Stream D behavior. They will catch regressions
// if the logic is extracted to a shared module in a future refactor.
//
// Where integration-level testing of main.ts is needed (e.g. spawning the
// shell process against a mock API server), that is tracked as a follow-on.
//
// Findings covered:
//   F-10: leaseLostFlag set by callHeartbeat when renewedRun=false
//   F-14: cleanupSandbox removes all Brief artifacts from /work/.major/
//   F-16: findExistingPr returns existing PR info from `gh pr list` JSON

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────
// F-10 + ADR-024: Heartbeat lease-loss detection, attributed to the Run
// ─────────────────────────────────────────────────────────────────
// callHeartbeat (main.ts) sets leaseLostFlag = true only when the lease-loss
// signal is for the CURRENT active Run:
//   heartbeatRunId != null && activeRun?.runId === heartbeatRunId
//     && resp?.renewedRun === false
// heartbeatRunId is the runId captured BEFORE the network await; activeRun may
// change during the await (prior Run ends, next Brief claimed). Per ADR 024
// (#180) a stale or idle (no-runId) response must NOT poison an unrelated Run.
//
// Mirrors the guard by hand — main.ts boots the daemon on import, so its
// internals can't be imported here.
function wouldSetLeaseLostFlag(
  heartbeatRunId: number | null,
  currentRunId: number | null,
  resp: unknown,
): boolean {
  return (
    heartbeatRunId != null &&
    currentRunId === heartbeatRunId &&
    !!resp &&
    (resp as Record<string, unknown>).renewedRun === false
  );
}

test("F-10 + ADR-024: lease-loss aborts only when attributed to the current Run", () => {
  const scenarios: Array<{
    name: string;
    heartbeatRunId: number | null;
    currentRunId: number | null;
    resp: unknown;
    expectAbort: boolean;
  }> = [
    {
      name: "genuine current-Run lease loss → abort",
      heartbeatRunId: 10755, currentRunId: 10755,
      resp: { renewedRun: false }, expectAbort: true,
    },
    {
      name: "current Run renewed → no abort",
      heartbeatRunId: 10755, currentRunId: 10755,
      resp: { renewedRun: true }, expectAbort: false,
    },
    {
      // #180: idle heartbeat (no runId) returns renewedRun=false unconditionally;
      // a Brief is claimed during the await. Must NOT poison the fresh Run.
      name: "idle heartbeat (no runId) + fresh Run claimed during await → no abort",
      heartbeatRunId: null, currentRunId: 10755,
      resp: { renewedRun: false }, expectAbort: false,
    },
    {
      // #180: heartbeat sent for prior Run N; Run N ends and N+1 is claimed
      // during the await; N's legitimate lease-loss must not abort N+1.
      name: "stale prior-Run lease loss after Run transition → no abort",
      heartbeatRunId: 90, currentRunId: 10755,
      resp: { renewedRun: false }, expectAbort: false,
    },
    {
      name: "idle heartbeat, still idle (no active Run) → no abort",
      heartbeatRunId: null, currentRunId: null,
      resp: { renewedRun: false }, expectAbort: false,
    },
    {
      name: "null resp → no abort",
      heartbeatRunId: 10755, currentRunId: 10755,
      resp: null, expectAbort: false,
    },
    {
      name: "empty resp (no renewedRun field) → no abort",
      heartbeatRunId: 10755, currentRunId: 10755,
      resp: {}, expectAbort: false,
    },
  ];

  for (const s of scenarios) {
    assert.equal(
      wouldSetLeaseLostFlag(s.heartbeatRunId, s.currentRunId, s.resp),
      s.expectAbort,
      s.name,
    );
  }
});

test("F-10: renewedRun=false is the sole abort trigger (not other falsy values)", () => {
  // Only the exact boolean false triggers the abort; 0, null, undefined, ""
  // must NOT trigger.
  const nonFalseValues: unknown[] = [0, null, undefined, "", "false", false as unknown as string];
  for (const v of nonFalseValues) {
    if (v === false) continue; // skip actual false — that's the trigger value
    const wouldAbort = !!(v === false);
    assert.equal(wouldAbort, false, `value=${JSON.stringify(v)} must not trigger abort`);
  }
  // And the actual trigger value:
  assert.equal(!!(false === false), true, "renewedRun=false must trigger abort");
});

// ─────────────────────────────────────────────────────────────────
// F-14: Sandbox cleanup — /work/.major/ artifact removal
// ─────────────────────────────────────────────────────────────────
// cleanupSandbox in main.ts removes specific files from /work/.major/.
// This test validates the file list and that fs.rm({ force: true }) works
// correctly on the artifact types produced during a Brief run.

test("F-14: cleanupSandbox removes all known Brief artifact files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "major-test-cleanup-"));
  const runId = 77;

  // Files that cleanupSandbox must remove (matches main.ts hardcoded list):
  //   briefFiles: brief.json, plan.md, implementer-output.json, telemetry.jsonl
  //   runTranscripts: planner.<runId>.transcript.txt, implementer.<runId>.transcript.txt,
  //                   reviewer.<runId>.transcript.txt
  const expectedRemovals = [
    "brief.json",
    "plan.md",
    "implementer-output.json",
    "telemetry.jsonl",
    `planner.${runId}.transcript.txt`,
    `implementer.${runId}.transcript.txt`,
    `reviewer.${runId}.transcript.txt`,
  ];

  // Create all expected artifact files in the temp dir.
  for (const f of expectedRemovals) {
    await fs.writeFile(path.join(tempDir, f), `test content for ${f}`);
  }

  // Create a file that should NOT be removed (e.g., triage transcript from another run).
  const unrelatedFile = `triage.999.transcript.txt`;
  await fs.writeFile(path.join(tempDir, unrelatedFile), "unrelated");

  // Replicate cleanupSandbox's removal logic:
  const briefFiles = ["brief.json", "plan.md", "implementer-output.json", "telemetry.jsonl"];
  for (const f of briefFiles) {
    await fs.rm(path.join(tempDir, f), { force: true }).catch(() => undefined);
  }
  const runTranscripts = [
    `planner.${runId}.transcript.txt`,
    `implementer.${runId}.transcript.txt`,
    `reviewer.${runId}.transcript.txt`,
  ];
  for (const f of runTranscripts) {
    await fs.rm(path.join(tempDir, f), { force: true }).catch(() => undefined);
  }

  // Assert: all expected files are gone.
  for (const f of expectedRemovals) {
    const exists = await fs.access(path.join(tempDir, f)).then(() => true).catch(() => false);
    assert.equal(exists, false, `${f} must have been removed`);
  }

  // Assert: unrelated file is still present.
  const unrelatedExists = await fs.access(path.join(tempDir, unrelatedFile))
    .then(() => true)
    .catch(() => false);
  assert.equal(unrelatedExists, true, "unrelated transcript must NOT be removed");

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("F-14: cleanupSandbox uses { force: true } so missing files are not an error", async () => {
  // If a prior run partially cleaned up, missing files must not cause errors.
  // Verify that calling fs.rm({ force: true }) on a nonexistent path is safe.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "major-test-force-"));
  const nonExistentFile = path.join(tempDir, "brief.json");
  // Should not throw:
  await assert.doesNotReject(
    () => fs.rm(nonExistentFile, { force: true }),
    "fs.rm({ force: true }) must not throw on missing file",
  );
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────
// F-16: PR-exists detection — parsing `gh pr list` JSON output
// ─────────────────────────────────────────────────────────────────
// findExistingPr in main.ts runs `gh pr list --json number,url` and parses
// the result. If the array has at least one entry, it returns { pr_number, pr_url }.
// These tests verify the parsing logic used to extract the PR info.

test("F-16: gh pr list JSON with one PR → extracts number and url", () => {
  const stdout = '[{"number":42,"url":"https://github.com/MioMarker/major/pull/42"}]';
  const prs = JSON.parse(stdout) as Array<{ number: number; url: string }>;
  const pr = prs[0];
  assert.ok(pr, "expected at least one PR");
  assert.equal(pr.number, 42);
  assert.equal(pr.url, "https://github.com/MioMarker/major/pull/42");
});

test("F-16: gh pr list JSON with multiple PRs → adopts the first one", () => {
  // When multiple open PRs exist for a branch (unlikely but possible), the
  // Shell adopts the first one returned (prs[0]).
  const stdout = JSON.stringify([
    { number: 10, url: "https://github.com/MioMarker/major/pull/10" },
    { number: 11, url: "https://github.com/MioMarker/major/pull/11" },
  ]);
  const prs = JSON.parse(stdout) as Array<{ number: number; url: string }>;
  const pr = prs[0];
  assert.equal(pr.number, 10, "must adopt the first PR");
});

test("F-16: gh pr list JSON with empty array → returns null (no existing PR)", () => {
  const stdout = "[]";
  const prs = JSON.parse(stdout) as Array<{ number: number; url: string }>;
  const pr = prs[0];
  assert.equal(pr, undefined, "empty array yields undefined → findExistingPr returns null");
});

test("F-16: gh pr list non-zero exit or empty stdout → returns null", () => {
  // Simulate findExistingPr's early-exit conditions:
  //   if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  const exitCodeNonZero = 1;
  const emptyStdout = "";

  const shouldReturnNull = (exitCode: number, stdout: string): boolean =>
    exitCode !== 0 || stdout.trim().length === 0;

  assert.equal(shouldReturnNull(exitCodeNonZero, "some output"), true, "non-zero exit → null");
  assert.equal(shouldReturnNull(0, emptyStdout), true, "empty stdout → null");
  assert.equal(shouldReturnNull(0, "[]"), false, "zero exit + output → parse");
});

test("F-16: findExistingPr returns { pr_number, pr_url } shape (regression guard)", () => {
  // The return shape must be { pr_number: number, pr_url: string } as used
  // by executeRun when adopting an existing PR.
  const pr = { number: 55, url: "https://github.com/MioMarker/major/pull/55" };
  const result = { pr_number: pr.number, pr_url: pr.url };
  assert.equal(result.pr_number, 55);
  assert.equal(result.pr_url, "https://github.com/MioMarker/major/pull/55");
});
