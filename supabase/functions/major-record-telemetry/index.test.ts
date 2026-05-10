// major-record-telemetry/index.test.ts — TelemetryWriter integration tests.
//
// Exercises TelemetryWriter against a real Postgres (the dev Supabase project).
// No Supabase client mocking — test data is inserted, exercised, and cleaned up.
//
// Run:
//   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> \
//     deno test --allow-net --allow-env index.test.ts
//
// Each test group creates ephemeral rows (brief + run) and deletes them in
// teardown so the dev DB stays clean.

import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert@^0.226.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { TelemetryWriter } from "./index.ts";
import type { MajorClient } from "../_shared/auth.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function getClient(): MajorClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — set both to run integration tests",
    );
  }
  // Cast is safe: esm.sh and JSR ship the same SupabaseClient shape; the type
  // mismatch is a TS structural incompatibility between the two module specifiers,
  // not a runtime difference.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "major" },
  }) as unknown as MajorClient;
}

interface TestFixture {
  client: MajorClient;
  briefId: number;
  runId: number;
  cleanup: () => Promise<void>;
}

async function createTestFixture(): Promise<TestFixture> {
  const client = getClient();

  // Insert a minimal brief in agent-running status.
  const { data: brief, error: briefErr } = await client
    .from("briefs")
    .insert({
      status: "agent-running",
      classifications: [],
      expected_paths: [],
    })
    .select("id")
    .single();

  if (briefErr || !brief) {
    throw new Error(`Failed to insert test brief: ${briefErr?.message ?? "no data"}`);
  }

  // Insert a minimal run in 'running' outcome.
  const { data: run, error: runErr } = await client
    .from("runs")
    .insert({
      brief_id: brief.id,
      purpose: "execute",
      outcome: "running",
      tachikoma_event_sequence: 0,
    })
    .select("id")
    .single();

  if (runErr || !run) {
    // Roll back brief on failure.
    await client.from("briefs").delete().eq("id", brief.id);
    throw new Error(`Failed to insert test run: ${runErr?.message ?? "no data"}`);
  }

  const cleanup = async () => {
    // Delete in FK-safe order: telemetry_records → runs → briefs.
    await client.from("telemetry_records").delete().eq("run_id", run.id);
    await client.from("runs").delete().eq("id", run.id);
    await client.from("briefs").delete().eq("id", brief.id);
  };

  return { client, briefId: brief.id, runId: run.id, cleanup };
}

function uniqueKey(label: string): string {
  return `test:${label}:${crypto.randomUUID()}`;
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("TelemetryWriter: writes a record and increments tachikoma_event_sequence", async () => {
  const { client, runId, cleanup } = await createTestFixture();
  try {
    const result = await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload: { command: "ls -la", cwd: "/work/repo", shell_id: "shell-test", decision: "observed" },
      idempotency_key: uniqueKey("write"),
    });

    assertExists(result.record);
    assertEquals(result.record.run_id, runId);
    assertEquals(result.record.observation_type, "tachikoma-bash-observed");

    // Verify the sequence counter was incremented.
    const { data: run, error } = await client
      .from("runs")
      .select("tachikoma_event_sequence")
      .eq("id", runId)
      .single();
    if (error) throw error;
    assertEquals(run.tachikoma_event_sequence, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("TelemetryWriter: idempotency — duplicate key returns existing row, sequence not re-incremented", async () => {
  const { client, runId, cleanup } = await createTestFixture();
  try {
    const key = uniqueKey("idem");
    const payload = { command: "git status", cwd: "/work/repo", shell_id: "shell-test", decision: "observed" };

    const first = await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload,
      idempotency_key: key,
    });

    // Post again with same key.
    const second = await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload,
      idempotency_key: key,
    });

    // Same row returned (same id).
    assertEquals(first.record.id, second.record.id);

    // Sequence should still be 1 (only incremented once).
    const { data: run, error } = await client
      .from("runs")
      .select("tachikoma_event_sequence")
      .eq("id", runId)
      .single();
    if (error) throw error;
    assertEquals(run.tachikoma_event_sequence, 1);
  } finally {
    await cleanup();
  }
});

Deno.test("TelemetryWriter: sanitizer-on-write — secret in payload lands redacted", async () => {
  const { client, runId, cleanup } = await createTestFixture();
  try {
    const secretCommand = "curl -H 'Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'";
    const result = await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload: { command: secretCommand, cwd: "/work/repo", shell_id: "shell-test", decision: "observed" },
      idempotency_key: uniqueKey("sanitize"),
    });

    const storedPayload = result.record.payload as Record<string, unknown>;
    const storedCommand = storedPayload.command as string;
    assertEquals(storedCommand.includes("sk-ant-"), false, "Raw Anthropic key must not be stored");
    assertEquals(storedCommand.includes("[REDACTED]"), true, "Redaction marker must be present");
  } finally {
    await cleanup();
  }
});

Deno.test("TelemetryWriter: sequence atomicity — two sequential writes get distinct sequence slots", async () => {
  const { client, runId, cleanup } = await createTestFixture();
  try {
    await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload: { command: "ls", cwd: "/work", shell_id: "shell-test", decision: "observed" },
      idempotency_key: uniqueKey("seq-1"),
    });
    await TelemetryWriter(client, {
      run_id: runId,
      observation_type: "tachikoma-bash-observed",
      payload: { command: "pwd", cwd: "/work", shell_id: "shell-test", decision: "observed" },
      idempotency_key: uniqueKey("seq-2"),
    });

    const { data: run, error } = await client
      .from("runs")
      .select("tachikoma_event_sequence")
      .eq("id", runId)
      .single();
    if (error) throw error;
    assertEquals(run.tachikoma_event_sequence, 2);

    // Both telemetry rows exist.
    const { data: records, error: rErr } = await client
      .from("telemetry_records")
      .select("id")
      .eq("run_id", runId);
    if (rErr) throw rErr;
    assertEquals(records?.length, 2);
    assertNotEquals(records![0].id, records![1].id);
  } finally {
    await cleanup();
  }
});
