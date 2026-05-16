// major-finalize-triage-session/index.test.ts
//
// Run: deno test --allow-none supabase/functions/major-finalize-triage-session/index.test.ts
//
// Focuses on collectExpectedPaths (F-04 path-blocker aggregation).

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { collectExpectedPaths, type ChangeOp } from "./index.ts";

// ────────────────────────────────────────────────────────────────────
// Mock client — returns configurable brief rows for in() query
// ────────────────────────────────────────────────────────────────────

interface BriefRow {
  id: number;
  expected_paths: string[] | null;
}

interface MockClientOpts {
  briefRows?: BriefRow[];
  briefQueryError?: { message: string } | null;
}

function makeMockClient(opts: MockClientOpts = {}) {
  let briefQueryCallCount = 0;

  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: { ids: unknown[] } = { ids: [] };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select(_cols?: string) {
        return builder;
      },
      in(_col: string, ids: unknown[]) {
        ctx.ids = ids;
        return builder;
      },
      then(
        resolve: (val: { data: unknown; error: unknown }) => void,
        _reject: (err: unknown) => void,
      ) {
        if (table === "briefs") {
          briefQueryCallCount++;
          if (opts.briefQueryError) {
            resolve({ data: null, error: opts.briefQueryError });
          } else {
            const filtered = (opts.briefRows ?? []).filter((r) =>
              (ctx.ids as number[]).includes(r.id)
            );
            resolve({ data: filtered, error: null });
          }
        } else {
          resolve({ data: [], error: null });
        }
      },
    };

    return builder;
  };

  return {
    client: { from } as never,
    getBriefQueryCallCount: () => briefQueryCallCount,
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function makeOp(
  operation_type: string,
  payload: Record<string, unknown>,
  sequence_index = 0,
): ChangeOp {
  return { operation_type, payload, sequence_index };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("create-brief op with expected_paths → paths appear in result", async () => {
  const { client } = makeMockClient();
  const ops = [
    makeOp("create-brief", { expected_paths: ["src/foo.ts", "src/bar.ts"] }),
  ];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(paths, ["src/foo.ts", "src/bar.ts"]);
});

Deno.test("set-ready-state op with expected_paths → paths appear in result", async () => {
  const { client } = makeMockClient();
  const ops = [
    makeOp("set-ready-state", { expected_paths: ["ui/components/Foo.tsx"] }),
  ];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(paths, ["ui/components/Foo.tsx"]);
});

Deno.test("transition-brief op to ready-for-agent → DB lookup returns brief's paths", async () => {
  const { client } = makeMockClient({
    briefRows: [{ id: 7, expected_paths: ["supabase/functions/major-foo/**"] }],
  });
  const ops = [makeOp("transition-brief", { to_status: "ready-for-agent", brief_id: 7 })];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(paths, ["supabase/functions/major-foo/**"]);
});

Deno.test("transition-brief op to wontfix → no paths collected, no DB query", async () => {
  const { client, getBriefQueryCallCount } = makeMockClient();
  const ops = [makeOp("transition-brief", { to_status: "wontfix", brief_id: 7 })];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(paths, []);
  assertEquals(getBriefQueryCallCount(), 0, "DB should not be queried for non-agent transitions");
});

Deno.test("multiple transition-brief ops → single batch DB query (not N calls)", async () => {
  const { client, getBriefQueryCallCount } = makeMockClient({
    briefRows: [
      { id: 1, expected_paths: ["a.ts"] },
      { id: 2, expected_paths: ["b.ts"] },
    ],
  });
  const ops = [
    makeOp("transition-brief", { to_status: "ready-for-agent", brief_id: 1 }, 0),
    makeOp("transition-brief", { to_status: "ready-for-agent", brief_id: 2 }, 1),
  ];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(getBriefQueryCallCount(), 1, "must issue exactly one batch DB query");
  assert(paths.includes("a.ts"));
  assert(paths.includes("b.ts"));
});

Deno.test("DB query failure → promise rejects (fail-closed)", async () => {
  const { client } = makeMockClient({
    briefQueryError: { message: "connection refused" },
  });
  const ops = [makeOp("transition-brief", { to_status: "ready-for-agent", brief_id: 5 })];
  let threw = false;
  try {
    await collectExpectedPaths(ops, client);
  } catch {
    threw = true;
  }
  assert(threw, "collectExpectedPaths must reject when DB query fails");
});

Deno.test("mixed ops: create-brief + set-ready-state + transition-brief → all paths collected", async () => {
  const { client } = makeMockClient({
    briefRows: [{ id: 10, expected_paths: ["db/types.ts"] }],
  });
  const ops = [
    makeOp("create-brief", { expected_paths: ["src/a.ts"] }),
    makeOp("set-ready-state", { expected_paths: ["src/b.ts"] }),
    makeOp("transition-brief", { to_status: "ready-for-agent", brief_id: 10 }),
  ];
  const paths = await collectExpectedPaths(ops, client);
  assert(paths.includes("src/a.ts"));
  assert(paths.includes("src/b.ts"));
  assert(paths.includes("db/types.ts"));
  assertEquals(paths.length, 3);
});

Deno.test("camelCase fallback: expectedPaths key is read when snake_case is absent", async () => {
  const { client } = makeMockClient();
  const ops = [
    makeOp("create-brief", { expectedPaths: ["fallback/path.ts"] }),
  ];
  const paths = await collectExpectedPaths(ops, client);
  assertEquals(paths, ["fallback/path.ts"]);
});

Deno.test("no ops → empty paths, no DB query", async () => {
  const { client, getBriefQueryCallCount } = makeMockClient();
  const paths = await collectExpectedPaths([], client);
  assertEquals(paths, []);
  assertEquals(getBriefQueryCallCount(), 0);
});
