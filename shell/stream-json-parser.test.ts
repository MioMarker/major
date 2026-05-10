// shell/stream-json-parser.test.ts — fixture-based tests for StreamJsonParser.
//
// Run: node --test --require ts-node/register stream-json-parser.test.ts
// (no network, no DB — pure function)

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamJsonParser } from "./stream-json-parser";

// ────────────────────────────────────────────────────────────────────
// Valid events — real Claude Code stream-json shapes
// ────────────────────────────────────────────────────────────────────

test("system init event parses correctly", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", cwd: "/work/repo", tools: [] });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "system");
    assert.equal(result.rawLine, line);
    assert.equal(result.body["subtype"], "init");
  }
});

test("assistant text event parses correctly", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
  });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "assistant");
    const body = result.body["message"] as Record<string, unknown>;
    assert.equal(body["role"], "assistant");
  }
});

test("user tool-result event parses correctly", () => {
  const line = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "" }] },
  });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "user");
  }
});

test("result completion event parses correctly", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    num_turns: 5,
    duration_ms: 12345,
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50 },
    result: '{"phase":"implementer","ok":true}',
  });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "result");
    assert.equal(result.body["num_turns"], 5);
    assert.equal(result.body["duration_ms"], 12345);
  }
});

test("unknown event type passes through as ParsedEvent", () => {
  const line = JSON.stringify({ type: "future_event_type", data: "something" });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "future_event_type");
  }
});

// ────────────────────────────────────────────────────────────────────
// Malformed JSON
// ────────────────────────────────────────────────────────────────────

test("malformed JSON returns ParseError", () => {
  const result = StreamJsonParser("not-valid-json");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /JSON parse failed/);
    assert.equal(result.rawLine, "not-valid-json");
  }
});

test("partial JSON object returns ParseError", () => {
  const result = StreamJsonParser('{"type": "assistant"');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /JSON parse failed/);
  }
});

test("JSON array returns ParseError", () => {
  const result = StreamJsonParser('[{"type":"assistant"}]');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not a JSON object/);
  }
});

test("JSON null returns ParseError", () => {
  const result = StreamJsonParser("null");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not a JSON object/);
  }
});

test("JSON number returns ParseError", () => {
  const result = StreamJsonParser("42");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not a JSON object/);
  }
});

test("empty line returns ParseError", () => {
  const result = StreamJsonParser("");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /empty line/);
  }
});

test("whitespace-only line returns ParseError", () => {
  const result = StreamJsonParser("   ");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /empty line/);
  }
});

// ────────────────────────────────────────────────────────────────────
// Missing / wrong-type fields
// ────────────────────────────────────────────────────────────────────

test("missing 'type' field returns ParseError", () => {
  const line = JSON.stringify({ subtype: "init", data: "hello" });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /type/);
  }
});

test("numeric 'type' field returns ParseError", () => {
  const line = JSON.stringify({ type: 42, data: "hello" });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /type/);
  }
});

test("empty-string 'type' field returns ParseError", () => {
  const line = JSON.stringify({ type: "", data: "hello" });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /type/);
  }
});

// ────────────────────────────────────────────────────────────────────
// Field truncation (4 KB cap)
// ────────────────────────────────────────────────────────────────────

test("string field exceeding 4 KB is truncated with marker", () => {
  const longText = "x".repeat(5000);
  const line = JSON.stringify({ type: "assistant", text: longText });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    const text = result.body["text"] as string;
    assert.ok(text.endsWith("…[truncated]"), `expected truncation marker, got suffix: ${text.slice(-20)}`);
    assert.ok(Buffer.from(text, "utf8").length <= 4096 + 20, "truncated field should be near the limit");
  }
});

test("rawLine exceeding 4 KB is truncated with marker", () => {
  // This invalid JSON line is longer than 4 KB.
  const longLine = "x".repeat(5000);
  const result = StreamJsonParser(longLine);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.rawLine.endsWith("…[truncated]"), "rawLine should carry truncation marker");
    assert.ok(Buffer.from(result.rawLine, "utf8").length <= 4096 + 20);
  }
});

test("nested string field exceeding 4 KB is truncated", () => {
  const longText = "y".repeat(5000);
  const line = JSON.stringify({ type: "user", message: { role: "user", content: longText } });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    const msg = result.body["message"] as Record<string, unknown>;
    const content = msg["content"] as string;
    assert.ok(content.endsWith("…[truncated]"));
  }
});

test("string field exactly at 4 KB passes through unchanged", () => {
  const exactText = "a".repeat(4096);
  const line = JSON.stringify({ type: "system", text: exactText });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body["text"], exactText);
  }
});

// ────────────────────────────────────────────────────────────────────
// Multi-chunk line assembly (simulated)
//
// StreamJsonParser is a per-line function; line assembly from chunks
// happens in tachikoma.ts. These tests verify that once a line is
// fully assembled (regardless of how many chunks it arrived in), the
// parser handles it correctly.
// ────────────────────────────────────────────────────────────────────

test("line assembled from two chunks parses correctly", () => {
  const part1 = '{"type": "user",';
  const part2 = ' "message": {"role": "user", "content": []}}';
  const fullLine = part1 + part2; // as assembled by the tachikoma line buffer
  const result = StreamJsonParser(fullLine);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "user");
  }
});

test("line assembled from three chunks parses correctly", () => {
  const parts = ['{"type":', ' "result", "num_turns":', ' 3}'];
  const fullLine = parts.join("");
  const result = StreamJsonParser(fullLine);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.eventKind, "result");
    assert.equal(result.body["num_turns"], 3);
  }
});

// ────────────────────────────────────────────────────────────────────
// Body non-string field types pass through unchanged
// ────────────────────────────────────────────────────────────────────

test("numeric body fields are preserved", () => {
  const line = JSON.stringify({ type: "result", num_turns: 7, duration_ms: 999 });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body["num_turns"], 7);
    assert.equal(result.body["duration_ms"], 999);
  }
});

test("boolean body fields are preserved", () => {
  const line = JSON.stringify({ type: "system", is_api_key_set: true });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.body["is_api_key_set"], true);
  }
});

test("array body fields are preserved without truncation of elements", () => {
  const line = JSON.stringify({ type: "system", tools: ["bash", "edit"] });
  const result = StreamJsonParser(line);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.body["tools"], ["bash", "edit"]);
  }
});
