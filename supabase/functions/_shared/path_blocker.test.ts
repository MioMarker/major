// _shared/path_blocker.test.ts — tests for matchesGlob and checkPathBlocker.
//
// Run: deno test --allow-none supabase/functions/_shared/path_blocker.test.ts
// (no network/env needed — pure functions)

import { assertEquals } from "jsr:@std/assert@^0.226.0";
import { checkPathBlocker, matchesGlob } from "./path_blocker.ts";

// ─────────────────────────────────────────────────────────────────
// matchesGlob — exact match
// ─────────────────────────────────────────────────────────────────

Deno.test("matchesGlob: exact match succeeds", () => {
  assertEquals(matchesGlob("app.config.ts", "app.config.ts"), true);
});

Deno.test("matchesGlob: exact match with wrong name fails", () => {
  assertEquals(matchesGlob("app.config.tsx", "app.config.ts"), false);
});

// ─────────────────────────────────────────────────────────────────
// matchesGlob — * (single segment, no slash)
// ─────────────────────────────────────────────────────────────────

Deno.test("matchesGlob: * matches any name in same directory", () => {
  assertEquals(matchesGlob("src/foo.ts", "src/*.ts"), true);
});

Deno.test("matchesGlob: * does not cross directory boundaries", () => {
  assertEquals(matchesGlob("src/sub/foo.ts", "src/*.ts"), false);
});

Deno.test("matchesGlob: * matches empty segment (prefix/suffix)", () => {
  assertEquals(matchesGlob("migration.sql", "*.sql"), true);
});

// ─────────────────────────────────────────────────────────────────
// matchesGlob — ** (any depth)
// ─────────────────────────────────────────────────────────────────

Deno.test("matchesGlob: ** matches file at root of prefix", () => {
  assertEquals(matchesGlob("supabase/migrations/0001_init.sql", "supabase/migrations/**"), true);
});

Deno.test("matchesGlob: ** matches nested file", () => {
  assertEquals(matchesGlob("supabase/functions/chat-with-ai/index.ts", "supabase/functions/chat-with-ai/**"), true);
});

Deno.test("matchesGlob: ** matches file without leading dir", () => {
  // '**/foo' must match 'foo' at the root.
  assertEquals(matchesGlob("foo.ts", "**/foo.ts"), true);
});

Deno.test("matchesGlob: ** glob does not match sibling directory", () => {
  assertEquals(matchesGlob("eval/report.json", "supabase/migrations/**"), false);
});

// ─────────────────────────────────────────────────────────────────
// matchesGlob — protected glob vocabulary from ADR 002
// ─────────────────────────────────────────────────────────────────

Deno.test("matchesGlob: .claude/rules/** matches nested rule file", () => {
  assertEquals(matchesGlob(".claude/rules/common/coding-style.md", ".claude/rules/**"), true);
});

Deno.test("matchesGlob: eval/** matches eval directory file", () => {
  assertEquals(matchesGlob("eval/smoke.ts", "eval/**"), true);
});

Deno.test("matchesGlob: supabase/migrations/** matches any migration", () => {
  assertEquals(matchesGlob("supabase/migrations/20260512000001_rpc_v2.sql", "supabase/migrations/**"), true);
});

Deno.test("matchesGlob: exact app.config.ts matches only that file", () => {
  assertEquals(matchesGlob("app.config.ts", "app.config.ts"), true);
  assertEquals(matchesGlob("app.config.tsx", "app.config.ts"), false);
  assertEquals(matchesGlob("sub/app.config.ts", "app.config.ts"), false);
});

// ─────────────────────────────────────────────────────────────────
// matchesGlob — ? (single character)
// ─────────────────────────────────────────────────────────────────

Deno.test("matchesGlob: ? matches exactly one non-slash character", () => {
  assertEquals(matchesGlob("file1.ts", "file?.ts"), true);
  assertEquals(matchesGlob("file12.ts", "file?.ts"), false);
});

// ─────────────────────────────────────────────────────────────────
// checkPathBlocker — path-glob intersection
// ─────────────────────────────────────────────────────────────────

Deno.test("checkPathBlocker: no paths, no rerank → needsHumanApply=false", () => {
  const result = checkPathBlocker([], 0, { protectedGlobs: ["supabase/migrations/**"], massRerankThreshold: 5 });
  assertEquals(result.needsHumanApply, false);
  assertEquals(result.reasons.length, 0);
});

Deno.test("checkPathBlocker: path matches protected glob → needsHumanApply=true", () => {
  const result = checkPathBlocker(
    ["supabase/migrations/0002_add_col.sql"],
    0,
    { protectedGlobs: ["supabase/migrations/**"], massRerankThreshold: 5 },
  );
  assertEquals(result.needsHumanApply, true);
  assertEquals(result.reasons.length, 1);
});

Deno.test("checkPathBlocker: path does not match any glob → needsHumanApply=false", () => {
  const result = checkPathBlocker(
    ["src/components/Foo.tsx"],
    0,
    { protectedGlobs: ["supabase/migrations/**", "eval/**"], massRerankThreshold: 5 },
  );
  assertEquals(result.needsHumanApply, false);
});

Deno.test("checkPathBlocker: multiple paths, one protected → needsHumanApply=true", () => {
  const result = checkPathBlocker(
    ["src/foo.ts", "supabase/migrations/new.sql"],
    0,
    { protectedGlobs: ["supabase/migrations/**"], massRerankThreshold: 5 },
  );
  assertEquals(result.needsHumanApply, true);
});

Deno.test("checkPathBlocker: rerank ops at threshold → needsHumanApply=false (threshold is exclusive)", () => {
  const result = checkPathBlocker([], 5, { protectedGlobs: [], massRerankThreshold: 5 });
  // threshold check is `>`, so exactly at threshold is safe
  assertEquals(result.needsHumanApply, false);
});

Deno.test("checkPathBlocker: rerank ops above threshold → needsHumanApply=true", () => {
  const result = checkPathBlocker([], 6, { protectedGlobs: [], massRerankThreshold: 5 });
  assertEquals(result.needsHumanApply, true);
  assertEquals(result.reasons[0].includes("mass-rerank threshold"), true);
});

Deno.test("checkPathBlocker: both path and rerank trigger → two reasons", () => {
  const result = checkPathBlocker(
    ["supabase/migrations/x.sql"],
    10,
    { protectedGlobs: ["supabase/migrations/**"], massRerankThreshold: 5 },
  );
  assertEquals(result.needsHumanApply, true);
  assertEquals(result.reasons.length, 2);
});

Deno.test("checkPathBlocker: reason text names the matching path and glob", () => {
  const path = "eval/test.ts";
  const glob = "eval/**";
  const result = checkPathBlocker([path], 0, { protectedGlobs: [glob], massRerankThreshold: 5 });
  assertEquals(result.needsHumanApply, true);
  assertEquals(result.reasons[0].includes(path), true);
  assertEquals(result.reasons[0].includes(glob), true);
});
