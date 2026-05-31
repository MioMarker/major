import type { Run, VerificationResult, TelemetryRecord } from "./types";

export type DispositionTone = "success" | "warning" | "destructive" | "info" | "muted";

export interface Disposition {
  label: string;
  tone: DispositionTone;
  /** Only set for planner scope-expansion stops. */
  additionalPathsNeeded?: string[];
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export function computeDisposition(
  run: Run,
  verifications: ReadonlyArray<VerificationResult>,
  telemetry: ReadonlyArray<TelemetryRecord>,
): Disposition {
  // 1. Planner scope expansion — takes priority over any outcome-based logic
  const plannerCheck = verifications.find((vr) => vr.check_name === "tachikoma-planner");
  if (plannerCheck) {
    const payload = asObject(plannerCheck.payload);
    if (payload?.scopeCheck === "expansion-needed") {
      return {
        label: "STOPPED — scope expansion",
        tone: "warning",
        additionalPathsNeeded: asStringArray(payload.additionalPathsNeeded),
      };
    }
  }

  // 2. Running
  if (run.outcome === "running") {
    return { label: "running…", tone: "info" };
  }

  // 3. Cancelled
  if (run.outcome === "cancelled") {
    switch (run.cancellation_reason) {
      case "lease-expired":
        return { label: "lease expired — requeued", tone: "warning" };
      case "human-cancellation":
        return { label: "cancelled by human", tone: "muted" };
      case "system-cancellation":
        return { label: "system cancelled", tone: "warning" };
      case "repair-acquisition":
        return { label: "repair acquired", tone: "info" };
      default:
        return { label: "cancelled", tone: "muted" };
    }
  }

  // 4. Succeeded
  if (run.outcome === "succeeded") {
    const required = verifications.filter((vr) => vr.required);
    const allPass = required.length === 0 || required.every((vr) => vr.outcome === "pass");
    if (allPass) return { label: "passed", tone: "success" };
    return { label: "passed (verification gap)", tone: "warning" };
  }

  // 5. Failed — check signals in priority order
  if (run.outcome === "failed") {
    const hasExternalError = telemetry.some(
      (rec) => rec.observation_type === "external-system-error",
    );
    if (hasExternalError) {
      return { label: "external error", tone: "destructive" };
    }

    const firstFailingRequired = verifications.find(
      (vr) => vr.required && vr.outcome === "fail",
    );
    if (firstFailingRequired) {
      return { label: `failed · ${firstFailingRequired.check_name}`, tone: "destructive" };
    }

    return { label: "failed", tone: "destructive" };
  }

  return { label: run.outcome, tone: "muted" };
}
