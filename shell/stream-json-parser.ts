// shell/stream-json-parser.ts — pure parser for Claude Code --output-format stream-json.
//
// One call per stdout line. Returns ParsedEvent on success, ParseError on any
// failure. Never throws. No I/O, no side effects — safe to call from any
// context and trivial to test with fixtures.

const FIELD_MAX_BYTES = 4096;
const TRUNCATE_SUFFIX = "…[truncated]";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface ParsedEvent {
  readonly ok: true;
  readonly eventKind: string;
  readonly body: Record<string, unknown>;
  /** Potentially truncated to FIELD_MAX_BYTES bytes. */
  readonly rawLine: string;
}

export interface ParseError {
  readonly ok: false;
  /** Potentially truncated to FIELD_MAX_BYTES bytes. */
  readonly rawLine: string;
  readonly reason: string;
}

export type StreamJsonLine = ParsedEvent | ParseError;

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

/**
 * Parse one raw stdout line from a Tachikoma subprocess invoked with
 * `--output-format stream-json`.
 *
 * String fields in the body are truncated to FIELD_MAX_BYTES bytes with a
 * "…[truncated]" suffix to bound persisted payload size. Secret sanitization
 * is not performed here — the TelemetryWriter (major-record-telemetry edge
 * function) handles that server-side before any persistence.
 */
export function StreamJsonParser(rawLine: string): StreamJsonLine {
  const safeRaw = truncateString(rawLine);

  if (rawLine.trim().length === 0) {
    return { ok: false, rawLine: safeRaw, reason: "empty line" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch (err) {
    return {
      ok: false,
      rawLine: safeRaw,
      reason: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, rawLine: safeRaw, reason: "event is not a JSON object" };
  }

  const eventKind = parsed["type"];
  if (typeof eventKind !== "string" || eventKind.length === 0) {
    return {
      ok: false,
      rawLine: safeRaw,
      reason: "missing or non-string 'type' field",
    };
  }

  return {
    ok: true,
    eventKind,
    body: truncateRecordStrings(parsed),
    rawLine: safeRaw,
  };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncateString(s: string): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= FIELD_MAX_BYTES) return s;
  return buf.slice(0, FIELD_MAX_BYTES).toString("utf8") + TRUNCATE_SUFFIX;
}

function truncateRecordStrings(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value === "string") return [key, truncateString(value)];
      if (isPlainObject(value)) return [key, truncateRecordStrings(value)];
      return [key, value];
    }),
  );
}
