// _shared/sanitizer.ts — redact secrets from text before persistence or logging.
//
// SecretSanitizer is a pure function: same input always produces the same
// output, no I/O, no side effects. It is safe to call in any context.
//
// Patterns are compiled once at module load to avoid re-parsing on every call.

const REDACT = "[REDACTED]";

// Ordered by specificity — more specific / longer prefixes first so they match
// before any shorter overlapping pattern can.
const SECRET_PATTERNS: readonly RegExp[] = [
  // Anthropic API keys (sk-ant-api03-…, sk-ant-…)
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  // Supabase new-format service-role secret (sb_secret_…)
  /sb_secret_[A-Za-z0-9_-]{10,}/g,
  // GitHub fine-grained PAT (github_pat_…)
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // GitHub classic PAT (ghp_…)
  /ghp_[A-Za-z0-9]{20,}/g,
  // GitHub OAuth app token (gho_…)
  /gho_[A-Za-z0-9]{20,}/g,
  // Supabase JWT-format service-role key (three-segment JWT, long payload)
  /eyJ[A-Za-z0-9_/+=-]{20,}\.[A-Za-z0-9_/+=-]{20,}\.[A-Za-z0-9_/+=-]{10,}/g,
  // GitHub webhook HMAC-SHA256 signature (X-Hub-Signature-256 header value)
  /sha256=[a-f0-9]{64}/g,
] as const;

/**
 * Replace known secret patterns in `text` with "[REDACTED]".
 * Pure function — no side effects.
 */
export function SecretSanitizer(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Reset `lastIndex` on global regexes before each use to avoid state bleed.
    (pattern as RegExp).lastIndex = 0;
    result = result.replace(pattern, REDACT);
  }
  return result;
}

const MAX_FIELD_BYTES = 4096;
const TRUNCATE_SUFFIX = "…[truncated]";

/**
 * Truncate a UTF-8 string to MAX_FIELD_BYTES bytes, appending a truncation
 * marker when the limit is exceeded.
 */
export function truncateField(text: string, maxBytes = MAX_FIELD_BYTES): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  const sliced = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return sliced + TRUNCATE_SUFFIX;
}

/**
 * Recursively sanitize and truncate all string values in a JSON-serializable
 * record. Non-string scalars and arrays are left as-is.
 */
export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, truncateField(SecretSanitizer(value))];
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return [key, sanitizeRecord(value as Record<string, unknown>)];
      }
      return [key, value];
    }),
  );
}
