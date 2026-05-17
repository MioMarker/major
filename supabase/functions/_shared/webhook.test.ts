// _shared/webhook.test.ts — tests for verifyGithubSignature.
//
// Run: deno test supabase/functions/_shared/webhook.test.ts
// (needs crypto — Deno's built-in, no network permission required)

import { assertEquals } from "jsr:@std/assert@^0.226.0";
import { verifyGithubSignature } from "./webhook.ts";

// ─────────────────────────────────────────────────────────────────
// Helpers — compute a valid HMAC-SHA256 signature for test bodies
// ─────────────────────────────────────────────────────────────────

async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(macBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ─────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────

Deno.test("verifyGithubSignature: valid signature returns true", async () => {
  const secret = "test-webhook-secret";
  const body = '{"action":"opened","pull_request":{}}';
  const sig = await sign(body, secret);
  const result = await verifyGithubSignature(body, sig, secret);
  assertEquals(result, true);
});

Deno.test("verifyGithubSignature: valid signature with empty body", async () => {
  const secret = "test-secret";
  const body = "";
  const sig = await sign(body, secret);
  assertEquals(await verifyGithubSignature(body, sig, secret), true);
});

Deno.test("verifyGithubSignature: valid signature with unicode body", async () => {
  const secret = "unicode-secret";
  const body = '{"title":"Plan — éàü 中文"}';
  const sig = await sign(body, secret);
  assertEquals(await verifyGithubSignature(body, sig, secret), true);
});

// ─────────────────────────────────────────────────────────────────
// Rejection cases — must return false, not throw
// ─────────────────────────────────────────────────────────────────

Deno.test("verifyGithubSignature: null header returns false", async () => {
  assertEquals(await verifyGithubSignature("body", null, "secret"), false);
});

Deno.test("verifyGithubSignature: header without sha256= prefix returns false", async () => {
  // Malformed header (no sha256= prefix) must be rejected.
  assertEquals(await verifyGithubSignature("body", "abc123", "secret"), false);
});

Deno.test("verifyGithubSignature: wrong secret returns false", async () => {
  const body = '{"action":"ping"}';
  const sig = await sign(body, "correct-secret");
  assertEquals(await verifyGithubSignature(body, sig, "wrong-secret"), false);
});

Deno.test("verifyGithubSignature: tampered body returns false", async () => {
  const secret = "my-secret";
  const originalBody = '{"action":"opened"}';
  const sig = await sign(originalBody, secret);
  const tamperedBody = '{"action":"closed"}';
  assertEquals(await verifyGithubSignature(tamperedBody, sig, secret), false);
});

Deno.test("verifyGithubSignature: wrong length hex returns false (length mismatch short-circuit)", async () => {
  // A signature with the correct prefix but truncated hex must be rejected
  // before byte-by-byte comparison (constant-time path requires equal lengths).
  const body = "test-body";
  const fakeSig = "sha256=abc";
  assertEquals(await verifyGithubSignature(body, fakeSig, "secret"), false);
});

Deno.test("verifyGithubSignature: all-zero hex with correct length returns false (content mismatch)", async () => {
  const body = "test-body";
  // 64 zeros is the right length for SHA-256 hex but almost certainly wrong.
  const fakeSig = "sha256=" + "0".repeat(64);
  assertEquals(await verifyGithubSignature(body, fakeSig, "secret"), false);
});

// ─────────────────────────────────────────────────────────────────
// Regression guard: F-24 — signature check must run before body parse.
// The function signature takes rawBody:string so the caller already has
// the text; verify that verifyGithubSignature is pure (no fetch, no IO).
// ─────────────────────────────────────────────────────────────────

Deno.test("verifyGithubSignature: accepts large body without truncation", async () => {
  const secret = "big-body-secret";
  const body = "x".repeat(1_000_000);
  const sig = await sign(body, secret);
  assertEquals(await verifyGithubSignature(body, sig, secret), true);
});
