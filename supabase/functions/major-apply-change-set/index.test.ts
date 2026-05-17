// major-apply-change-set/index.test.ts
//
// Run: deno test --allow-all supabase/functions/major-apply-change-set/
//
// Tests the HTTP layer of major-apply-change-set via the exported handler
// function with a mocked Supabase client.
//
// Attribution paths (issue #80):
//   Path A — GitHub-seeded session (entry_point = 'integration:github'):
//     The SQL RPC receives p_actor but internally sets author_actor =
//     'agent:triage-tachikoma' and populates source_issue_* from
//     trigger_payload. From the TypeScript layer, the edge function always
//     passes auth.actor as p_actor — the SQL decides the final author_actor.
//     This test verifies the correct actor string is forwarded to the RPC.
//
//   Path B — Human-initiated session (no trigger_payload):
//     The SQL RPC uses p_actor as author_actor and leaves source_issue_*
//     null. Same TypeScript behavior as Path A — p_actor is passed through.
//
// The SQL-level attribution distinction is verified by the migration
// (20260513000000_apply_change_set_source_issue_attribution.sql) and
// exercised by integration tests against a live Supabase project.

import { assertEquals } from "jsr:@std/assert@^0.226.0";
import { handler, __testing } from "./index.ts";
import type { AuthenticateResult } from "../_shared/auth.ts";

// ─────────────────────────────────────────────────────────────────────
// Mock builder
// ─────────────────────────────────────────────────────────────────────

type RpcCall = { fnName: string; params: Record<string, unknown> };

type MockClientOptions = {
  changeSet?: { id: number; decision: string } | null;
  rpcData?: unknown;
  rpcError?: { message: string } | null;
};

function makeMockClient(opts: MockClientOptions = {}): {
  // deno-lint-ignore no-explicit-any
  client: any;
  rpcCalls: RpcCall[];
} {
  const rpcCalls: RpcCall[] = [];
  const changeSet = "changeSet" in opts ? opts.changeSet : { id: 1, decision: "proposed" };

  const client = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          single: () =>
            Promise.resolve(
              changeSet
                ? { data: changeSet, error: null }
                : { data: null, error: { message: "not found" } },
            ),
        }),
      }),
    }),
    rpc: (fnName: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fnName, params });
      if (opts.rpcError) {
        return Promise.resolve({ data: null, error: opts.rpcError });
      }
      const data = opts.rpcData ?? [{ applied_op_count: 2 }];
      return Promise.resolve({ data, error: null });
    },
  };

  return { client, rpcCalls };
}

function mockAuth(
  actor: string,
  clientOpts: MockClientOptions = {},
): { authFn: () => Promise<AuthenticateResult>; rpcCalls: RpcCall[] } {
  const { client, rpcCalls } = makeMockClient(clientOpts);
  const authFn = () =>
    Promise.resolve({
      ok: true as const,
      kind: "human" as const,
      client,
      user: null,
      userId: null,
      actor,
    });
  return { authFn, rpcCalls };
}

function makeRequest(body: unknown, method = "POST"): Request {
  return new Request("https://example.com/major-apply-change-set", {
    method,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

function cleanup(): void {
  __testing.reset();
}

// ─────────────────────────────────────────────────────────────────────
// HTTP validation
// ─────────────────────────────────────────────────────────────────────

Deno.test("non-POST returns 405", async () => {
  const req = new Request("https://example.com/major-apply-change-set", {
    method: "GET",
  });
  try {
    const res = await handler(req);
    assertEquals(res.status, 405);
  } finally {
    cleanup();
  }
});

Deno.test("auth failure returns 401", async () => {
  __testing.setAuth(() =>
    Promise.resolve({ ok: false as const, status: 401, message: "Invalid or expired token" })
  );
  try {
    const req = makeRequest({ changeSetId: 1 });
    const res = await handler(req);
    assertEquals(res.status, 401);
  } finally {
    cleanup();
  }
});

Deno.test("missing changeSetId returns 400", async () => {
  const { authFn } = mockAuth("human:jonathan");
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({});
    const res = await handler(req);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  } finally {
    cleanup();
  }
});

Deno.test("change set not found returns 404", async () => {
  const { authFn } = mockAuth("human:jonathan", { changeSet: null });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 99 });
    const res = await handler(req);
    assertEquals(res.status, 404);
  } finally {
    cleanup();
  }
});

Deno.test("change set already accepted returns 409", async () => {
  const { authFn } = mockAuth("human:jonathan", {
    changeSet: { id: 1, decision: "accepted" },
  });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 1 });
    const res = await handler(req);
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error, "Change set already accepted");
  } finally {
    cleanup();
  }
});

Deno.test("change set already rejected returns 409", async () => {
  const { authFn } = mockAuth("human:jonathan", {
    changeSet: { id: 1, decision: "rejected" },
  });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 1 });
    const res = await handler(req);
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error, "Change set already rejected");
  } finally {
    cleanup();
  }
});

Deno.test("RPC error returns 500", async () => {
  const { authFn } = mockAuth("human:jonathan", {
    rpcError: { message: "deadlock detected" },
  });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 1 });
    const res = await handler(req);
    assertEquals(res.status, 500);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────
// Path A: GitHub-seeded session
//
// The SQL RPC receives p_actor = 'human:jonathan' but internally sets
// author_actor = 'agent:triage-tachikoma' and populates source_issue_*
// from the session's trigger_payload (because entry_point =
// 'integration:github'). The edge function's job is to forward the
// correct actor and idempotency root to the RPC — verified here.
// ─────────────────────────────────────────────────────────────────────

Deno.test("Path A (GitHub-seeded): RPC called with correct actor and idempotency root", async () => {
  const { authFn, rpcCalls } = mockAuth("human:jonathan", {
    rpcData: [{ applied_op_count: 2 }],
  });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 7 });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.appliedOpCount, 2);

    assertEquals(rpcCalls.length, 1);
    const call = rpcCalls[0];
    assertEquals(call.fnName, "apply_change_set");
    assertEquals(call.params.p_change_set_id, 7);
    assertEquals(call.params.p_actor, "human:jonathan");
    assertEquals(call.params.p_idempotency_root, "manual-apply-7");
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────
// Path B: Human-initiated session
//
// The SQL RPC uses p_actor as author_actor and leaves source_issue_*
// null (no trigger_payload on the session). Same TypeScript behavior
// as Path A — p_actor is passed through unchanged.
// ─────────────────────────────────────────────────────────────────────

Deno.test("Path B (human-initiated): RPC called with human actor, response includes appliedOpCount", async () => {
  const { authFn, rpcCalls } = mockAuth("human:kuvekep14", {
    rpcData: [{ applied_op_count: 3 }],
  });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 42 });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.appliedOpCount, 3);

    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].params.p_actor, "human:kuvekep14");
    assertEquals(rpcCalls[0].params.p_change_set_id, 42);
  } finally {
    cleanup();
  }
});

Deno.test("RPC returning empty array yields appliedOpCount 0", async () => {
  const { authFn } = mockAuth("human:jonathan", { rpcData: [] });
  __testing.setAuth(authFn);
  try {
    const req = makeRequest({ changeSetId: 5 });
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.appliedOpCount, 0);
  } finally {
    cleanup();
  }
});

Deno.test("OPTIONS preflight returns 200 with CORS headers", async () => {
  const req = new Request("https://example.com/major-apply-change-set", {
    method: "OPTIONS",
    headers: {
      "Origin": "https://app.example.com",
      "Access-Control-Request-Method": "POST",
    },
  });
  try {
    const res = await handler(req);
    assertEquals(res.status, 200);
  } finally {
    cleanup();
  }
});
