// major-finalize-run/index.test.ts
//
// Run: deno test --allow-all supabase/functions/major-finalize-run/index.test.ts
//
// Tests for finalizeRunCore (F-24 error redaction).

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { finalizeRunCore } from "./index.ts";
import type { FinalizeBody } from "./index.ts";

// ────────────────────────────────────────────────────────────────────
// Minimal valid body
// ────────────────────────────────────────────────────────────────────

function validBody(overrides?: Partial<FinalizeBody>): FinalizeBody {
  return {
    runId: 1,
    outcome: "succeeded",
    nextStatus: "ready-for-review",
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Mock client builder
// ────────────────────────────────────────────────────────────────────

function makeMockClient(opts: {
  rpcError?: { message: string } | null;
  rpcData?: unknown;
  rpcThrows?: boolean;
}) {
  // deno-lint-ignore no-explicit-any
  const rpc = (_name: string, _params: unknown): any => {
    if (opts.rpcThrows) {
      throw new Error("unexpected internal exception: db credentials invalid");
    }
    return Promise.resolve({
      data: opts.rpcData ?? [{ brief_id: 5, run_id: 1 }],
      error: opts.rpcError ?? null,
    });
  };

  return { rpc } as never;
}

// ────────────────────────────────────────────────────────────────────
// F-24 tests
// ────────────────────────────────────────────────────────────────────

Deno.test("F-24: RPC error → 500 with generic message, DB error text not leaked", async () => {
  const client = makeMockClient({
    rpcError: { message: "connection refused: host=db.supabase.co port=5432" },
  });

  const res = await finalizeRunCore(client, "shell:shell-D", validBody());
  assertEquals(res.status, 500);

  const body = await res.json() as unknown;
  const bodyStr = JSON.stringify(body);
  assert(
    !bodyStr.includes("connection refused"),
    `DB error text must not leak to caller, got: ${bodyStr}`,
  );
  assert(
    !bodyStr.includes("db.supabase.co"),
    `DB hostname must not leak to caller, got: ${bodyStr}`,
  );
});

Deno.test("F-24: unexpected exception in core → 500 with generic message", async () => {
  const client = makeMockClient({ rpcThrows: true });

  const res = await finalizeRunCore(client, "shell:shell-D", validBody());
  assertEquals(res.status, 500);

  const body = await res.json() as unknown;
  const bodyStr = JSON.stringify(body);
  assert(
    !bodyStr.includes("db credentials invalid"),
    `Exception message must not leak to caller, got: ${bodyStr}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// Validation tests
// ────────────────────────────────────────────────────────────────────

Deno.test("happy path: RPC succeeds → 200 with briefId and runId", async () => {
  const client = makeMockClient({ rpcData: [{ brief_id: 42, run_id: 99 }] });
  const res = await finalizeRunCore(client, "shell:shell-D", validBody());
  assertEquals(res.status, 200);
  const body = await res.json() as { briefId: number; runId: number };
  assertEquals(body.briefId, 42);
  assertEquals(body.runId, 99);
});

Deno.test("nextStatus not in allowlist → 400", async () => {
  const client = makeMockClient({});
  const res = await finalizeRunCore(
    client,
    "shell:shell-D",
    validBody({ nextStatus: "done" }),
  );
  assertEquals(res.status, 400);
});

Deno.test("ready-for-human without handoffReason → 400", async () => {
  const client = makeMockClient({});
  const res = await finalizeRunCore(
    client,
    "shell:shell-D",
    validBody({ nextStatus: "ready-for-human" }),
  );
  assertEquals(res.status, 400);
});
