// shell/planner-helpers.test.ts — fixture-based tests for the Phase 0
// planner gate + output parser.
//
// Run: node --test --require ts-node/register planner-helpers.test.ts
// (no network, no DB — pure functions)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlannerOutput, shouldRunPlanner } from "./planner-helpers";
import type { TachikomaBriefSnapshot } from "./tachikoma";

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function makeBrief(overrides: Partial<TachikomaBriefSnapshot> = {}): TachikomaBriefSnapshot {
  return {
    id: 1,
    title: "test brief",
    status: "agent-running",
    classifications: ["bug-fix"],
    expectedArtifactType: "git-change",
    expectedPaths: ["src/foo.ts"],
    baseBranch: "dev",
    gitRepositoryRef: "MioMarker/healthbite",
    contentMd: "# fixture\n",
    currentRevisionId: 1,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// shouldRunPlanner — gate per ADR 013 / Phase 1 Decision 1
// ────────────────────────────────────────────────────────────────────

test("gate: single-path bug-fix → planner does NOT run", () => {
  const brief = makeBrief({ classifications: ["bug-fix"], expectedPaths: ["src/foo.ts"] });
  assert.equal(shouldRunPlanner(brief), false);
});

test("gate: single-path feature → planner does NOT run", () => {
  const brief = makeBrief({ classifications: ["feature"], expectedPaths: ["src/foo.ts"] });
  assert.equal(shouldRunPlanner(brief), false);
});

test("gate: multi-path (2 paths) → planner runs", () => {
  const brief = makeBrief({ expectedPaths: ["src/foo.ts", "src/foo.test.ts"] });
  assert.equal(shouldRunPlanner(brief), true);
});

test("gate: multi-path (3 paths) → planner runs", () => {
  const brief = makeBrief({
    expectedPaths: ["src/foo.ts", "src/bar.ts", "src/baz.ts"],
  });
  assert.equal(shouldRunPlanner(brief), true);
});

test("gate: epic classification (single-path) → planner runs", () => {
  const brief = makeBrief({ classifications: ["epic"], expectedPaths: ["docs/plan.md"] });
  assert.equal(shouldRunPlanner(brief), true);
});

test("gate: parent classification (single-path) → planner runs", () => {
  const brief = makeBrief({ classifications: ["parent"], expectedPaths: ["docs/plan.md"] });
  assert.equal(shouldRunPlanner(brief), true);
});

test("gate: epic + multi-path → planner runs (covered by either branch)", () => {
  const brief = makeBrief({
    classifications: ["epic"],
    expectedPaths: ["docs/plan.md", "src/foo.ts"],
  });
  assert.equal(shouldRunPlanner(brief), true);
});

test("gate: empty expectedPaths, bug-fix → planner does NOT run", () => {
  // Edge: a Brief with zero expectedPaths shouldn't trigger the multi-path
  // branch (length > 1 is false). Triage should never produce this; if it
  // does, the implementer's expected-paths-insufficient bail catches it.
  const brief = makeBrief({ expectedPaths: [] });
  assert.equal(shouldRunPlanner(brief), false);
});

test("gate: docs classification → planner does NOT run (single-path)", () => {
  const brief = makeBrief({ classifications: ["docs"], expectedPaths: ["README.md"] });
  assert.equal(shouldRunPlanner(brief), false);
});

test("gate: refactor classification → planner does NOT run (single-path)", () => {
  const brief = makeBrief({ classifications: ["refactor"], expectedPaths: ["src/foo.ts"] });
  assert.equal(shouldRunPlanner(brief), false);
});

test("gate: combined classifications (epic + bug-fix) → planner runs", () => {
  const brief = makeBrief({
    classifications: ["bug-fix", "epic"],
    expectedPaths: ["src/foo.ts"],
  });
  assert.equal(shouldRunPlanner(brief), true);
});

// ────────────────────────────────────────────────────────────────────
// parsePlannerOutput — final-line JSON envelope per planner.md
// ────────────────────────────────────────────────────────────────────

test("parser: valid in-scope plan parses with files + verification", () => {
  const raw = {
    phase: "planner",
    ok: true,
    files_planned: ["src/foo.ts", "src/foo.test.ts"],
    scope_check: "in-scope",
    additional_paths_needed: [],
    verification_plan: ["tsc-noemit", "npm test"],
    estimated_iterations: 2,
    plan_path: "/work/.major/plan.md",
  };
  const parsed = parsePlannerOutput(raw);
  assert.notEqual(parsed, null);
  if (parsed) {
    assert.equal(parsed.ok, true);
    assert.equal(parsed.scope_check, "in-scope");
    assert.deepEqual(parsed.files_planned, ["src/foo.ts", "src/foo.test.ts"]);
    assert.equal(parsed.estimated_iterations, 2);
  }
});

test("parser: expansion-needed plan parses with additional_paths_needed", () => {
  const raw = {
    phase: "planner",
    ok: true,
    files_planned: ["src/foo.ts"],
    scope_check: "expansion-needed",
    additional_paths_needed: ["src/shared/util.ts", "src/shared/types.ts"],
    verification_plan: [],
    estimated_iterations: 0,
    plan_path: "/work/.major/plan.md",
  };
  const parsed = parsePlannerOutput(raw);
  assert.notEqual(parsed, null);
  if (parsed) {
    assert.equal(parsed.scope_check, "expansion-needed");
    assert.deepEqual(parsed.additional_paths_needed, [
      "src/shared/util.ts",
      "src/shared/types.ts",
    ]);
  }
});

test("parser: failed planner (ok=false) parses but no scope_check required", () => {
  const raw = { phase: "planner", ok: false };
  const parsed = parsePlannerOutput(raw);
  assert.notEqual(parsed, null);
  if (parsed) {
    assert.equal(parsed.ok, false);
    assert.equal(parsed.scope_check, undefined);
  }
});

test("parser: wrong phase → null (refuse to misattribute)", () => {
  const raw = { phase: "implementer", ok: true };
  assert.equal(parsePlannerOutput(raw), null);
});

test("parser: missing phase → null", () => {
  const raw = { ok: true, files_planned: [] };
  assert.equal(parsePlannerOutput(raw), null);
});

test("parser: null input → null", () => {
  assert.equal(parsePlannerOutput(null), null);
});

test("parser: undefined input → null", () => {
  assert.equal(parsePlannerOutput(undefined), null);
});

test("parser: string input → null", () => {
  assert.equal(parsePlannerOutput("not an object"), null);
});

test("parser: number input → null", () => {
  assert.equal(parsePlannerOutput(42), null);
});

test("parser: array input → null (typeof object but not the planner shape)", () => {
  // Arrays pass `typeof === "object"` but lack the phase discriminator.
  assert.equal(parsePlannerOutput(["phase", "planner"]), null);
});
