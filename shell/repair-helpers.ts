// shell/repair-helpers.ts — Pure utility functions for the Repair Run path.
//
// Extracted so they can be unit-tested without importing main.ts (which
// auto-starts the Shell daemon on import). No I/O, no HTTP, no side effects.

// ────────────────────────────────────────────────────────────────────
// Secret sanitization — matches the patterns in _shared/sanitizer.ts
// ────────────────────────────────────────────────────────────────────

// Compiled once at module load; reset lastIndex before each use.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sb_secret_[A-Za-z0-9_-]{10,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_/+=-]{20,}\.[A-Za-z0-9_/+=-]{20,}\.[A-Za-z0-9_/+=-]{10,}/g,
  /sha256=[a-f0-9]{64}/g,
] as const;

const REDACT = "[REDACTED]";

/** Replace known secret patterns with "[REDACTED]". Pure — no side effects. */
export function sanitizeText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACT);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Transcript tail extraction
// ────────────────────────────────────────────────────────────────────

export const TRANSCRIPT_TAIL_BYTES = 4096;

/**
 * Take the last `maxBytes` characters of `text`, then apply secret redaction.
 * Used to build the inspected_run_transcript_tail.txt file for Repair Tachikoma.
 */
export function sanitizeTranscriptTail(text: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string {
  const tail = text.length > maxBytes ? text.slice(-maxBytes) : text;
  return sanitizeText(tail);
}

// ────────────────────────────────────────────────────────────────────
// Re-arm decision (ADR 014)
// ────────────────────────────────────────────────────────────────────

/**
 * Return true if a failed Run should be re-armed to ready-for-agent
 * instead of parked at ready-for-human.
 *
 * Condition (ADR 014): attempt_number < max_attempts.
 * Equality is NOT re-armable — hitting the cap parks the Brief.
 */
export function shouldRearm(attemptNumber: number, maxAttempts: number): boolean {
  return attemptNumber < maxAttempts;
}
