// major-reject-brief/index.test.ts
//
// Run: deno test --allow-all supabase/functions/major-reject-brief/index.test.ts
//
// Tests for rejectBriefCore (F-02, ADR-011).

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { rejectBriefCore } from "./index.ts";
import { __testing as githubTesting } from "../_shared/github-issue.ts";

// ────────────────────────────────────────────────────────────────────
// Mock client builder
// ────────────────────────────────────────────────────────────────────

type Recorded =
  | { kind: "brief-fetch"; briefId: string }
  | { kind: "brief-update" }
  | { kind: "event-insert"; rows: unknown[] }
  | { kind: "other"; table: string };

interface BriefRow {
  id: number;
  status: string;
}

interface MockOpts {
  fetchRow: BriefRow | null;
  fetchError?: { message: string } | null;
  updateError?: { message: string } | null;
}

function makeMockClient(opts: MockOpts) {
  const recorded: Recorded[] = [];

  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: {
      op: "select" | "update" | "insert" | null;
      filterId: string | null;
      insertRows: unknown[];
    } = { op: null, filterId: null, insertRows: [] };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select(_cols?: string) {
        if (ctx.op === null) ctx.op = "select";
        return builder;
      },
      update(_fields: unknown) {
        ctx.op = "update";
        return builder;
      },
      insert(rows: unknown) {
        ctx.op = "insert";
        ctx.insertRows = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      eq(_col: string, val: unknown) {
        if (_col === "id") ctx.filterId = String(val);
        return builder;
      },
      single() {
        if (table === "briefs" && ctx.op === "select") {
          recorded.push({ kind: "brief-fetch", briefId: ctx.filterId ?? "?" });
          if (opts.fetchError) return Promise.resolve({ data: null, error: opts.fetchError });
          return Promise.resolve({ data: opts.fetchRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // update returns a thenable (no .select().single() in rejectBriefCore)
      then(
        resolve: (val: { data: unknown; error: unknown }) => void,
        _reject: (err: unknown) => void,
      ) {
        if (table === "briefs" && ctx.op === "update") {
          recorded.push({ kind: "brief-update" });
          resolve({ data: null, error: opts.updateError ?? null });
        } else if (table === "events" && ctx.op === "insert") {
          recorded.push({ kind: "event-insert", rows: ctx.insertRows });
          resolve({ data: null, error: null });
        } else {
          recorded.push({ kind: "other", table });
          resolve({ data: null, error: null });
        }
      },
    };

    return builder;
  };

  return { client: { from } as never, recorded };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("happy path: non-terminal brief → 200 with { briefId, status: 'wontfix' }", async () => {
  const { client } = makeMockClient({ fetchRow: { id: 5, status: "ready-for-agent" } });
  const res = await rejectBriefCore(client, 5, "not needed", "human:test");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.briefId, 5);
  assertEquals(body.status, "wontfix");
});

Deno.test("brief not found (fetch returns null) → 404", async () => {
  const { client } = makeMockClient({ fetchRow: null });
  const res = await rejectBriefCore(client, 99, "reason", "human:test");
  assertEquals(res.status, 404);
});

Deno.test("fetch error → 404", async () => {
  const { client } = makeMockClient({
    fetchRow: null,
    fetchError: { message: "pg error" },
  });
  const res = await rejectBriefCore(client, 99, "reason", "human:test");
  assertEquals(res.status, 404);
  const body = await res.json();
  // F-24: DB error must not leak
  assert(!JSON.stringify(body).includes("pg error"), "DB error must not leak");
});

Deno.test("already terminal status=done → 409", async () => {
  const { client } = makeMockClient({ fetchRow: { id: 3, status: "done" } });
  const res = await rejectBriefCore(client, 3, "reason", "human:test");
  assertEquals(res.status, 409);
});

Deno.test("already terminal status=wontfix → 409", async () => {
  const { client } = makeMockClient({ fetchRow: { id: 3, status: "wontfix" } });
  const res = await rejectBriefCore(client, 3, "reason", "human:test");
  assertEquals(res.status, 409);
});

Deno.test("F-02: idempotency keys are stable across repeated calls for the same briefId", async () => {
  const { client, recorded } = makeMockClient({
    fetchRow: { id: 11, status: "ready-for-agent" },
  });
  await rejectBriefCore(client, 11, "duplicate reason", "human:bob");

  const { client: client2, recorded: recorded2 } = makeMockClient({
    fetchRow: { id: 11, status: "ready-for-agent" },
  });
  await rejectBriefCore(client2, 11, "duplicate reason", "human:bob");

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

Deno.test("F-02: rejected event idempotency key uses reject-<briefId> seed", async () => {
  const { client, recorded } = makeMockClient({
    fetchRow: { id: 22, status: "needs-info" },
  });
  await rejectBriefCore(client, 22, "reason", "human:carol");
  const events = recorded.find((r) => r.kind === "event-insert");
  assert(events, "expected event-insert");
  const rows = events.rows as Array<{ type: string; idempotency_key: string }>;
  const rejected = rows.find((r) => r.type === "rejected");
  assert(rejected, "expected rejected event");
  assert(
    rejected.idempotency_key.includes("reject-22"),
    `expected key to contain 'reject-22', got: ${rejected.idempotency_key}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// ADR-011: postResolutionAndClose happy path
// ────────────────────────────────────────────────────────────────────

type GithubCall = { url: string; method: string; body: string | undefined };

function installGithubMock(): { calls: GithubCall[]; reset: () => void } {
  const calls: GithubCall[] = [];
  githubTesting.setDeps({
    env: (key) => key === "GITHUB_APP_TOKEN" ? "mock-token" : undefined,
    fetch: (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
      const method = ((init as { method?: string })?.method ?? "GET").toUpperCase();
      const body = typeof (init as { body?: unknown })?.body === "string"
        ? (init as { body: string }).body
        : undefined;
      calls.push({ url, method, body });

      if (method === "GET" && url.includes("/comments")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      if (method === "GET" && url.endsWith("/user")) {
        return Promise.resolve(new Response(JSON.stringify({ login: "major-bot" }), { status: 200 }));
      }
      if (method === "POST" && url.includes("/comments")) {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      }
      if (method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ number: 1, state: "closed" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "unmatched" }), { status: 599 }));
    },
  });
  return { calls, reset: () => githubTesting.resetDeps() };
}

// Extended mock client: supports runs + verification_results queries.
function makeMockClientWithIssue(opts: {
  fetchRow: Record<string, unknown> | null;
  latestRunId?: number | null;
}) {
  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: { op: string | null; filters: Record<string, string> } =
      { op: null, filters: {} };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select(_cols?: string) {
        if (!ctx.op) ctx.op = "select";
        return builder;
      },
      update(_fields: unknown) {
        ctx.op = "update";
        return builder;
      },
      insert(_rows: unknown) {
        ctx.op = "insert";
        return builder;
      },
      eq(col: string, val: unknown) {
        ctx.filters[col] = String(val);
        return builder;
      },
      order(_col: string, _opts?: unknown) {
        return builder;
      },
      limit(_n: number) {
        return builder;
      },
      single() {
        if (table === "briefs") {
          return Promise.resolve({ data: opts.fetchRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle() {
        if (table === "runs") {
          const runId = opts.latestRunId ?? null;
          return Promise.resolve({
            data: runId !== null ? { id: runId } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(
        resolve: (val: { data: unknown; error: unknown }) => void,
        _reject: (e: unknown) => void,
      ) {
        if (table === "verification_results") {
          resolve({ data: [], error: null });
        } else {
          resolve({ data: null, error: null });
        }
      },
    };

    return builder;
  };

  return { from } as never;
}

Deno.test("ADR-011 happy path: postResolutionAndClose called with closeReason 'not_planned'", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const client = makeMockClientWithIssue({
      fetchRow: {
        id: 5,
        status: "ready-for-agent",
        source_issue_repo: "MioMarker/healthbite",
        source_issue_number: 3,
        title: "The brief",
        pr_url: null,
      },
      latestRunId: 55,
    });

    const res = await rejectBriefCore(client, 5, "not needed anymore", "human:alice");
    assertEquals(res.status, 200);

    const patchCall = calls.find((c) => c.method === "PATCH");
    assert(patchCall, "expected a PATCH call to close the source issue");
    const patchBody = JSON.parse(patchCall.body ?? "{}") as {
      state?: string;
      state_reason?: string;
    };
    assertEquals(patchBody.state_reason, "not_planned");
  } finally {
    reset();
  }
});

Deno.test("ADR-011 rejection reason included in comment body", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const client = makeMockClientWithIssue({
      fetchRow: {
        id: 6,
        status: "needs-info",
        source_issue_repo: "MioMarker/healthbite",
        source_issue_number: 4,
        title: "Brief 6",
        pr_url: null,
      },
      latestRunId: null,
    });

    await rejectBriefCore(client, 6, "out of scope for this quarter", "human:bob");

    const commentPost = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    assert(commentPost, "expected a POST to comments");
    assert(
      commentPost.body?.includes("out of scope for this quarter"),
      "comment body must include the rejection reason",
    );
  } finally {
    reset();
  }
});

Deno.test("ADR-011: no GitHub call when source_issue_repo is null", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const client = makeMockClientWithIssue({
      fetchRow: { id: 7, status: "ready-for-agent", source_issue_repo: null, source_issue_number: null },
    });
    const res = await rejectBriefCore(client, 7, "reason", "human:alice");
    assertEquals(res.status, 200);
    assertEquals(calls.length, 0, "no GitHub API calls when source_issue_repo is null");
  } finally {
    reset();
  }
});
