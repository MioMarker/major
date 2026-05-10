// shell/planner-helpers.ts — pure helpers for the Phase 0 planner wiring.
//
// Extracted from main.ts so they can be unit-tested without importing the
// daemon entry point (which boots on import).

import type { TachikomaBriefSnapshot } from "./tachikoma";

export interface PlannerOutput {
  ok: boolean;
  files_planned?: string[];
  scope_check?: "in-scope" | "expansion-needed";
  additional_paths_needed?: string[];
  verification_plan?: string[];
  estimated_iterations?: number;
  plan_path?: string;
}

/** Pull a PlannerOutput out of the Tachikoma's parsed final-line JSON. */
export function parsePlannerOutput(raw: unknown): PlannerOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.phase !== "planner") return null;
  return obj as unknown as PlannerOutput;
}

/**
 * Per ADR 013 / Phase 1 Decision 1: planner runs on Briefs that benefit from
 * explicit decomposition — multi-path or `epic`/`parent` classification.
 * Ship cheap first; broaden the gate later from data.
 */
export function shouldRunPlanner(brief: TachikomaBriefSnapshot): boolean {
  return (
    brief.expectedPaths.length > 1 ||
    brief.classifications.includes("epic") ||
    brief.classifications.includes("parent")
  );
}
