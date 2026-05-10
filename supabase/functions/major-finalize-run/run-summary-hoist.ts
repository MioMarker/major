// supabase/functions/major-finalize-run/run-summary-hoist.ts
//
// Pure helper: extract summary metrics from a stream-json 'result' event body.
// No side effects, no I/O — safe to call from any context and trivial to test.

export interface RunSummaryMetrics {
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  /** Full final assistant message; no truncation (runs.final_text carries it verbatim). */
  readonly finalText: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Extract summary metrics from the body of a stream-json 'result' event.
 *
 * Maps Claude Code stream-json fields to the runs column schema:
 *   body.num_turns                        → numTurns
 *   body.duration_ms                      → durationMs
 *   body.result                           → finalText
 *   body.usage.input_tokens               → inputTokens
 *   body.usage.output_tokens              → outputTokens
 *   body.usage.cache_read_input_tokens    → cacheReadTokens
 *   body.usage.cache_creation_input_tokens → cacheWriteTokens
 *
 * All fields default to null when absent or malformed. The caller handles
 * missing telemetry; Run Finalization always succeeds regardless.
 */
export function RunSummaryHoist(body: Record<string, unknown>): RunSummaryMetrics {
  const numTurns = asInt(body["num_turns"]);
  const durationMs = asInt(body["duration_ms"]);
  const finalText = typeof body["result"] === "string" ? body["result"] : null;

  const usage = isPlainObject(body["usage"]) ? body["usage"] : {};
  const inputTokens = asInt(usage["input_tokens"]);
  const outputTokens = asInt(usage["output_tokens"]);
  const cacheReadTokens = asInt(usage["cache_read_input_tokens"]);
  const cacheWriteTokens = asInt(usage["cache_creation_input_tokens"]);

  return {
    numTurns,
    durationMs,
    finalText,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}
