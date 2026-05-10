// _shared/sanitizer.test.ts — fixture-based tests for SecretSanitizer.
//
// Run: deno test --allow-none supabase/functions/_shared/sanitizer.test.ts
// (no network/env needed — pure function)

import { assertEquals } from "jsr:@std/assert@^0.226.0";
import { secretSanitizer, truncateField, sanitizeRecord } from "./sanitizer.ts";

// ────────────────────────────────────────────────────────────────────
// Positive cases — each pattern must be redacted
// ────────────────────────────────────────────────────────────────────

Deno.test("SecretSanitizer: Anthropic API key (sk-ant-…)", () => {
  const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
  const input = `Authorization: Bearer ${key}`;
  const result = secretSanitizer(input);
  assertEquals(result, "Authorization: Bearer [REDACTED]");
});

Deno.test("SecretSanitizer: Supabase service-role key (sb_secret_…)", () => {
  const key = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  const result = secretSanitizer(`key=${key}`);
  assertEquals(result, "key=[REDACTED]");
});

Deno.test("SecretSanitizer: GitHub fine-grained PAT (github_pat_…)", () => {
  const key = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstu";
  const result = secretSanitizer(`GITHUB_TOKEN=${key}`);
  assertEquals(result, "GITHUB_TOKEN=[REDACTED]");
});

Deno.test("SecretSanitizer: GitHub classic PAT (ghp_…)", () => {
  const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
  const result = secretSanitizer(`token ${key} something`);
  assertEquals(result, "token [REDACTED] something");
});

Deno.test("SecretSanitizer: GitHub OAuth token (gho_…)", () => {
  const key = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
  const result = secretSanitizer(key);
  assertEquals(result, "[REDACTED]");
});

Deno.test("SecretSanitizer: Supabase JWT-format service-role key (eyJ…)", () => {
  // Three-segment JWT with sufficiently long payload/signature segments.
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
    ".eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNjAwMDAwMDAwfQ" +
    ".ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij";
  const result = secretSanitizer(`Bearer ${jwt}`);
  assertEquals(result, "Bearer [REDACTED]");
});

Deno.test("SecretSanitizer: HMAC-SHA256 webhook signature (sha256=…)", () => {
  const sig = "sha256=" + "a".repeat(64);
  const result = secretSanitizer(`X-Hub-Signature-256: ${sig}`);
  assertEquals(result, "X-Hub-Signature-256: [REDACTED]");
});

Deno.test("SecretSanitizer: multiple secrets in one string", () => {
  const sk = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA";
  const ghp = "ghp_BBBBBBBBBBBBBBBBBBBBBBBB";
  const result = secretSanitizer(`key1=${sk} key2=${ghp}`);
  assertEquals(result, "key1=[REDACTED] key2=[REDACTED]");
});

// ────────────────────────────────────────────────────────────────────
// Negative cases — similar-looking strings that must NOT be redacted
// ────────────────────────────────────────────────────────────────────

Deno.test("SecretSanitizer: short sk-ant prefix (under 10 chars suffix) passes through", () => {
  const notAKey = "sk-ant-abc"; // only 3 chars after the prefix — below threshold
  const result = secretSanitizer(notAKey);
  assertEquals(result, notAKey);
});

Deno.test("SecretSanitizer: sb_prefix_ but wrong keyword passes through", () => {
  const notAKey = "sb_public_abcdefghijklmnopqrstuvwxyz";
  const result = secretSanitizer(notAKey);
  assertEquals(result, notAKey);
});

Deno.test("SecretSanitizer: github_pat_ but too short passes through", () => {
  const notAKey = "github_pat_short"; // under 20-char threshold
  const result = secretSanitizer(notAKey);
  assertEquals(result, notAKey);
});

Deno.test("SecretSanitizer: ghp_ but too short passes through", () => {
  const notAKey = "ghp_short"; // under 20-char threshold
  const result = secretSanitizer(notAKey);
  assertEquals(result, notAKey);
});

Deno.test("SecretSanitizer: eyJ JWT but too short segments passes through", () => {
  // Only two segments — not a valid three-segment JWT
  const notJwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9";
  const result = secretSanitizer(notJwt);
  assertEquals(result, notJwt);
});

Deno.test("SecretSanitizer: sha256= but wrong hex length passes through", () => {
  // Only 10 hex chars — not a full SHA-256 digest (which is 64 chars)
  const notSig = "sha256=abcdef1234";
  const result = secretSanitizer(notSig);
  assertEquals(result, notSig);
});

Deno.test("SecretSanitizer: plain text passes through unchanged", () => {
  const plain = "ls -la /work/repo && git status";
  const result = secretSanitizer(plain);
  assertEquals(result, plain);
});

// ────────────────────────────────────────────────────────────────────
// truncateField
// ────────────────────────────────────────────────────────────────────

Deno.test("truncateField: short string passes through unchanged", () => {
  const s = "hello";
  assertEquals(truncateField(s), s);
});

Deno.test("truncateField: string exactly at limit passes through unchanged", () => {
  const s = "x".repeat(4096);
  assertEquals(truncateField(s), s);
});

Deno.test("truncateField: string over limit gets truncated with suffix", () => {
  const s = "x".repeat(4097);
  const result = truncateField(s);
  assertEquals(result.endsWith("…[truncated]"), true);
  assertEquals(new TextEncoder().encode(result).length > 4096, true);
});

// ────────────────────────────────────────────────────────────────────
// sanitizeRecord
// ────────────────────────────────────────────────────────────────────

Deno.test("sanitizeRecord: redacts string values recursively", () => {
  const record: Record<string, unknown> = {
    command: "curl -H 'auth: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'",
    cwd: "/work/repo",
    nested: { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234" },
    count: 42,
  };
  const result = sanitizeRecord(record);
  assertEquals((result.command as string).includes("[REDACTED]"), true);
  assertEquals(result.cwd, "/work/repo");
  assertEquals(
    ((result.nested as Record<string, unknown>).token as string).includes("[REDACTED]"),
    true,
  );
  assertEquals(result.count, 42);
});
