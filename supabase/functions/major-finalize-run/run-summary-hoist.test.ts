// run-summary-hoist.test.ts — fixture tests for RunSummaryHoist.
//
// Pure unit tests: no DB, no network. Run with:
//   deno test run-summary-hoist.test.ts

import { assertEquals } from "jsr:@std/assert@^0.226.0";
import { RunSummaryHoist } from "./run-summary-hoist.ts";

Deno.test("RunSummaryHoist: nominal case — all fields present", () => {
  const body = {
    type: "result",
    subtype: "success",
    num_turns: 12,
    duration_ms: 34500,
    result: "I've completed the implementation.",
    usage: {
      input_tokens: 1200,
      output_tokens: 450,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 300,
    },
  };
  const m = RunSummaryHoist(body);
  assertEquals(m.numTurns, 12);
  assertEquals(m.durationMs, 34500);
  assertEquals(m.finalText, "I've completed the implementation.");
  assertEquals(m.inputTokens, 1200);
  assertEquals(m.outputTokens, 450);
  assertEquals(m.cacheReadTokens, 800);
  assertEquals(m.cacheWriteTokens, 300);
});

Deno.test("RunSummaryHoist: missing fields — all metrics default to null", () => {
  const body = { type: "result", subtype: "error_max_turns" };
  const m = RunSummaryHoist(body);
  assertEquals(m.numTurns, null);
  assertEquals(m.durationMs, null);
  assertEquals(m.finalText, null);
  assertEquals(m.inputTokens, null);
  assertEquals(m.outputTokens, null);
  assertEquals(m.cacheReadTokens, null);
  assertEquals(m.cacheWriteTokens, null);
});

Deno.test("RunSummaryHoist: zero values — returned as zero, not null", () => {
  const body = {
    num_turns: 0,
    duration_ms: 0,
    result: "",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
  const m = RunSummaryHoist(body);
  assertEquals(m.numTurns, 0);
  assertEquals(m.durationMs, 0);
  assertEquals(m.finalText, "");
  assertEquals(m.inputTokens, 0);
  assertEquals(m.outputTokens, 0);
  assertEquals(m.cacheReadTokens, 0);
  assertEquals(m.cacheWriteTokens, 0);
});

Deno.test("RunSummaryHoist: very large finalText — passes through untruncated", () => {
  const longText = "x".repeat(200_000);
  const body = {
    result: longText,
    num_turns: 1,
    duration_ms: 100,
    usage: { input_tokens: 50_000, output_tokens: 10_000 },
  };
  const m = RunSummaryHoist(body);
  assertEquals(m.finalText?.length, 200_000);
  assertEquals(m.finalText, longText);
  assertEquals(m.numTurns, 1);
  assertEquals(m.inputTokens, 50_000);
  assertEquals(m.outputTokens, 10_000);
  assertEquals(m.cacheReadTokens, null);
  assertEquals(m.cacheWriteTokens, null);
});
