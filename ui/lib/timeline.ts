import type { Run, VerificationResult, TelemetryRecord } from "./types";
import type { Disposition } from "./disposition";
import { computeDisposition } from "./disposition";
import { isExceptionalTelemetry } from "./telemetry-summary";

export interface TimelineRun {
  run: Run;
  disposition: Disposition;
  verifications: ReadonlyArray<VerificationResult>;
  /** Stream events + non-denied bash observations — hidden behind chip. */
  routineTelemetry: ReadonlyArray<TelemetryRecord>;
  /** Denied bash + parse errors + external-system-error — always visible. */
  exceptionalTelemetry: ReadonlyArray<TelemetryRecord>;
  /** True for the most recent run (highest id) — drives current brief status. */
  isCurrent: boolean;
}

export function buildTimeline(
  runs: ReadonlyArray<Run>,
  verifications: ReadonlyArray<VerificationResult>,
  telemetry: ReadonlyArray<TelemetryRecord>,
): ReadonlyArray<TimelineRun> {
  const verByRun = new Map<number, VerificationResult[]>();
  for (const vr of verifications) {
    const list = verByRun.get(vr.run_id) ?? [];
    list.push(vr);
    verByRun.set(vr.run_id, list);
  }

  const telByRun = new Map<number, TelemetryRecord[]>();
  for (const rec of telemetry) {
    if (rec.run_id === null) continue;
    const list = telByRun.get(rec.run_id) ?? [];
    list.push(rec);
    telByRun.set(rec.run_id, list);
  }

  const maxRunId = runs.reduce((max, r) => Math.max(max, r.id), -Infinity);
  const sorted = [...runs].sort((a, b) => b.id - a.id);

  return sorted.map((run): TimelineRun => {
    const runVerifications = verByRun.get(run.id) ?? [];
    const runTelemetry = telByRun.get(run.id) ?? [];

    const exceptionalTelemetry = runTelemetry.filter(isExceptionalTelemetry);
    const routineTelemetry = runTelemetry.filter((rec) => !isExceptionalTelemetry(rec));
    const disposition = computeDisposition(run, runVerifications, runTelemetry);

    return {
      run,
      disposition,
      verifications: runVerifications,
      routineTelemetry,
      exceptionalTelemetry,
      isCurrent: run.id === maxRunId,
    };
  });
}
