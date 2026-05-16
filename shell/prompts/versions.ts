// Versioned constants for each Tachikoma role's prompt.
//
// Convention (mirrors HealthBite chat-with-ai): bump to today's date in
// `<role>@YYYY-MM-DD` format on any prompt edit. The Shell attaches
// the version to verification_results / telemetry on every Run so we can
// correlate prompt changes to outcomes.
//
// AGENTS.md hard rule #7: changing any prompt MUST bump the matching constant
// in this file. Don't ship a prompt edit without it.

export const IMPLEMENTER_PROMPT_VERSION = "implementer@2026-05-10";
export const REVIEWER_PROMPT_VERSION    = "reviewer@2026-05-10";
export const PLANNER_PROMPT_VERSION     = "planner@2026-05-10";
export const TRIAGE_PROMPT_VERSION      = "triage@2026-05-11";
export const REPAIR_PROMPT_VERSION      = "repair@2026-05-12";

// Map a role to its version constant. Used by tachikoma.ts so callers can pass
// `role` and get back the matching version without a switch at every call site.
export const PROMPT_VERSION_BY_ROLE: Record<TachikomaRole, string> = {
  implementer: IMPLEMENTER_PROMPT_VERSION,
  reviewer:    REVIEWER_PROMPT_VERSION,
  planner:     PLANNER_PROMPT_VERSION,
  triage:      TRIAGE_PROMPT_VERSION,
  repair:      REPAIR_PROMPT_VERSION,
};

export type TachikomaRole = "implementer" | "reviewer" | "planner" | "triage" | "repair";
