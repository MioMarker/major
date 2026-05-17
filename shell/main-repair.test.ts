// shell/main-repair.test.ts — unit tests for ADR 014 Repair Run helpers.
//
// Tests the pure functions extracted to repair-helpers.ts:
//   - sanitizeText (secret-pattern redaction)
//   - sanitizeTranscriptTail (truncation + redaction)
//   - shouldRearm (ADR 014 re-arm gate)
//
// No network, no DB, no subprocess — pure-function fixture tests.
//
// Run: node --test --require ts-node/register main-repair.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, sanitizeTranscriptTail, shouldRearm, TRANSCRIPT_TAIL_BYTES } from "./repair-helpers";

// ────────────────────────────────────────────────────────────────────
// sanitizeText — secret-pattern redaction
// ────────────────────────────────────────────────────────────────────

test("sanitizeText: no secrets → text unchanged", () => {
  const text = "no secrets here, just a normal string";
  assert.equal(sanitizeText(text), text);
});

test("sanitizeText: redacts Anthropic API key (sk-ant-api03-)", () => {
  const key = "sk-ant-api03-ABCDEFGHIJKLMN";
  const text = `token=${key} rest`;
  assert.ok(sanitizeText(text).includes("[REDACTED]"));
  assert.ok(!sanitizeText(text).includes(key));
});

test("sanitizeText: redacts GitHub classic PAT (ghp_)", () => {
  const key = "ghp_ABCDEFGHIJKLMNOPQRST12";
  const text = `export GITHUB_TOKEN=${key}`;
  const sanitized = sanitizeText(text);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(!sanitized.includes(key));
});

test("sanitizeText: redacts GitHub fine-grained PAT (github_pat_)", () => {
  const key = "github_pat_ABCDEFGHIJKLMNOPQRSTU";
  const text = `GH_TOKEN=${key}`;
  const sanitized = sanitizeText(text);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(!sanitized.includes(key));
});

test("sanitizeText: redacts Supabase JWT format", () => {
  // Three-segment JWT with long payloads.
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const sanitized = sanitizeText(`Authorization: Bearer ${jwt}`);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(!sanitized.includes(jwt));
});

test("sanitizeText: redacts GitHub OAuth token (gho_)", () => {
  const key = "gho_ABCDEFGHIJKLMNOPQRSTU12";
  const sanitized = sanitizeText(`token ${key}`);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(!sanitized.includes(key));
});

test("sanitizeText: redacts sha256 HMAC signature", () => {
  const sig = "sha256=" + "a".repeat(64);
  const sanitized = sanitizeText(`X-Hub-Signature-256: ${sig}`);
  assert.ok(sanitized.includes("[REDACTED]"));
  assert.ok(!sanitized.includes(sig));
});

test("sanitizeText: multiple secrets in one string → all redacted", () => {
  const k1 = "ghp_ABCDEFGHIJKLMNOPQRSTU12";
  const k2 = "sk-ant-api03-ABCDEFGHIJKLMN";
  const text = `token=${k1} key=${k2}`;
  const sanitized = sanitizeText(text);
  assert.ok(!sanitized.includes(k1));
  assert.ok(!sanitized.includes(k2));
  // Both replaced with [REDACTED]
  assert.equal((sanitized.match(/\[REDACTED\]/g) ?? []).length, 2);
});

test("sanitizeText: empty string → empty string", () => {
  assert.equal(sanitizeText(""), "");
});

// ────────────────────────────────────────────────────────────────────
// sanitizeTranscriptTail — truncation + redaction
// ────────────────────────────────────────────────────────────────────

test("sanitizeTranscriptTail: short text → returned in full", () => {
  const text = "short transcript";
  assert.equal(sanitizeTranscriptTail(text), text);
});

test("sanitizeTranscriptTail: text longer than maxBytes → last N chars returned", () => {
  const maxBytes = 10;
  const text = "abcde12345XXXXXXXXXX"; // 20 chars; last 10 = "XXXXXXXXXX"
  assert.equal(sanitizeTranscriptTail(text, maxBytes), "XXXXXXXXXX");
});

test("sanitizeTranscriptTail: exactly maxBytes → returned in full", () => {
  const text = "a".repeat(TRANSCRIPT_TAIL_BYTES);
  assert.equal(sanitizeTranscriptTail(text).length, TRANSCRIPT_TAIL_BYTES);
});

test("sanitizeTranscriptTail: secret near end → redacted", () => {
  const key = "ghp_ABCDEFGHIJKLMNOPQRSTU12";
  const text = "..." + key;
  const result = sanitizeTranscriptTail(text);
  assert.ok(!result.includes(key));
  assert.ok(result.includes("[REDACTED]"));
});

test("sanitizeTranscriptTail: secret in early part (outside tail) → not redacted if not included", () => {
  // Build a string where the secret is in the FIRST half and the tail has none.
  const key = "ghp_ABCDEFGHIJKLMNOPQRSTU12";
  const tailContent = "safe content only";
  // Make the prefix long enough that the tail doesn't include the key.
  const prefix = key + "x".repeat(TRANSCRIPT_TAIL_BYTES);
  const text = prefix + tailContent;
  const result = sanitizeTranscriptTail(text);
  // The tail is the last TRANSCRIPT_TAIL_BYTES characters — just 'x...tailContent'.
  // The key is only in the prefix so it should not appear in the result.
  assert.ok(!result.includes(key));
});

// ────────────────────────────────────────────────────────────────────
// shouldRearm — ADR 014 re-arm gate
// ────────────────────────────────────────────────────────────────────

test("shouldRearm: attempt 1 of 3 → true (below budget)", () => {
  assert.equal(shouldRearm(1, 3), true);
});

test("shouldRearm: attempt 2 of 3 → true (still below budget)", () => {
  assert.equal(shouldRearm(2, 3), true);
});

test("shouldRearm: attempt 3 of 3 → false (at budget cap)", () => {
  assert.equal(shouldRearm(3, 3), false);
});

test("shouldRearm: attempt 4 of 3 → false (above budget)", () => {
  // Human override can produce attempt > max; cap applies.
  assert.equal(shouldRearm(4, 3), false);
});

test("shouldRearm: attempt 1 of 1 → false (zero-retry budget)", () => {
  assert.equal(shouldRearm(1, 1), false);
});

test("shouldRearm: attempt 0 of 3 → true (edge: pre-attempt)", () => {
  // Shouldn't occur in practice but the function handles it correctly.
  assert.equal(shouldRearm(0, 3), true);
});

test("shouldRearm: large budget → true below, false at cap", () => {
  assert.equal(shouldRearm(9, 10), true);
  assert.equal(shouldRearm(10, 10), false);
});
