// major-confirm-qa/index.test.ts
//
// Run: deno test --allow-none supabase/functions/major-confirm-qa/index.test.ts
//
// Tests for confirmQaCore (F-19, F-02).

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { confirmQaCore } from "./index.ts";

// ────────────────────────────────────────────────────────────────────
// Mock client builder
// ────────────────────────────────────────────────────────────────────

type Recorded =
  | { kind: "brief-update"; filters: Record<string, string>; updateFields: Record<string, unknown> }
  | { kind: "event-insert"; rows: unknown[] }
  | { kind: "other"; table: string; op: string };

interface MockUpdateOpts {
  updatedRow: { id: number; status: string } | null;
  updateError?: { message: string } | null;
}

function makeMockClient(opts: MockUpdateOpts) {
  const recorded: Recorded[] = [];

  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: {
      op: "update" | "insert" | "select" | null;
      filters: Record<string, string>;
      updateFields: Record<string, unknown>;
      insertRows: unknown[];
    } = { op: null, filters: {}, updateFields: {}, insertRows: [] };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      update(fields: Record<string, unknown>) {
        ctx.op = "update";
        ctx.updateFields = fields;
        return builder;
      },
      insert(rows: unknown) {
        ctx.op = "insert";
        ctx.insertRows = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        ctx.filters[col] = String(val);
        return builder;
      },
      maybeSingle() {
        if (table === "briefs" && ctx.op === "update") {
          recorded.push({
            kind: "brief-update",
            filters: { ...ctx.filters },
            updateFields: { ...ctx.updateFields },
          });
          if (opts.updateError) {
            return Promise.resolve({ data: null, error: opts.updateError });
          }
          return Promise.resolve({ data: opts.updatedRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // events insert returns a thenable (no terminal .single())
      then(
        resolve: (val: { data: unknown; error: null }) => void,
        _reject: (err: unknown) => void,
      ) {
        if (table === "events" && ctx.op === "insert") {
          recorded.push({ kind: "event-insert", rows: ctx.insertRows });
        } else {
          recorded.push({ kind: "other", table, op: ctx.op ?? "unknown" });
        }
        resolve({ data: null, error: null });
      },
    };

    return builder;
  };

  return { client: { from } as never, recorded };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("happy path: brief updated → 200 with { briefId, status: 'done' }", async () => {
  const { client } = makeMockClient({ updatedRow: { id: 42, status: "done" } });
  const res = await confirmQaCore(client, 42, "human:test");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.briefId, 42);
  assertEquals(body.status, "done");
});

Deno.test("F-19: not ready-for-review OR not merged → 409", async () => {
  const { client } = makeMockClient({ updatedRow: null });
  const res = await confirmQaCore(client, 99, "human:test");
  assertEquals(res.status, 409);
});

Deno.test("F-19: pr_status filter is included in the conditional update", async () => {
  const { client, recorded } = makeMockClient({ updatedRow: { id: 42, status: "done" } });
  await confirmQaCore(client, 42, "human:test");
  const update = recorded.find((r) => r.kind === "brief-update");
  assert(update, "expected brief-update to be recorded");
  // Both conditions must be present in the filter
  assertEquals(update.filters["status"], "ready-for-review");
  assertEquals(update.filters["pr_status"], "merged");
});

Deno.test("DB error on update → 500", async () => {
  const { client } = makeMockClient({
    updatedRow: null,
    updateError: { message: "connection refused" },
  });
  const res = await confirmQaCore(client, 42, "human:test");
  assertEquals(res.status, 500);
  const body = await res.json();
  // F-24: error text must not leak to the client
  assert(!JSON.stringify(body).includes("connection refused"), "DB error must not leak");
});

Deno.test("F-02: idempotency keys are deterministic (no Date.now())", async () => {
  const { client, recorded } = makeMockClient({ updatedRow: { id: 7, status: "done" } });
  await confirmQaCore(client, 7, "human:alice");

  // Call again — keys must be identical (no time component)
  const { client: client2, recorded: recorded2 } = makeMockClient({
    updatedRow: { id: 7, status: "done" },
  });
  await confirmQaCore(client2, 7, "human:alice");

  const events1 = recorded.find((r) => r.kind === "event-insert");
  const events2 = recorded2.find((r) => r.kind === "event-insert");
  assert(events1 && events2, "expected event-insert on both calls");
  const rows1 = events1.rows as Array<{ idempotency_key: string }>;
  const rows2 = events2.rows as Array<{ idempotency_key: string }>;
  assertEquals(rows1.length, 2, "expected 2 events");
  assertEquals(rows1[0].idempotency_key, rows2[0].idempotency_key, "keys must be identical");
  assertEquals(rows1[1].idempotency_key, rows2[1].idempotency_key, "keys must be identical");
  // Confirm no time-based suffix
  assert(!rows1[0].idempotency_key.match(/\d{10,}/), "key must not contain a timestamp");
});

Deno.test("F-02: accepted event idempotency key uses qa-confirm-<briefId> seed", async () => {
  const { client, recorded } = makeMockClient({ updatedRow: { id: 42, status: "done" } });
  await confirmQaCore(client, 42, "human:alice");
  const events = recorded.find((r) => r.kind === "event-insert");
  assert(events, "expected event-insert");
  const rows = events.rows as Array<{ type: string; idempotency_key: string }>;
  const accepted = rows.find((r) => r.type === "accepted");
  assert(accepted, "expected accepted event");
  assert(
    accepted.idempotency_key.includes("qa-confirm-42"),
    `expected key to contain 'qa-confirm-42', got: ${accepted.idempotency_key}`,
  );
});
