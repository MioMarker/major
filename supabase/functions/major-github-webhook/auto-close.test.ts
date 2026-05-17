// major-github-webhook/auto-close.test.ts
//
// Run: deno test --allow-all supabase/functions/major-github-webhook/auto-close.test.ts
//
// Tests for the maybeAutoCloseBrief path (ADR 011): verifies that
// postResolutionAndClose is called with the correct closeReason for both
// merged (→ completed) and non-merged (→ not_planned) PR-close events.

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { handlePullRequest } from "./index.ts";
import { __testing } from "../_shared/github-issue.ts";

// ────────────────────────────────────────────────────────────────────
// GitHub API mock helpers
// ────────────────────────────────────────────────────────────────────

type GithubCall = { url: string; method: string; body: string | undefined };

function installGithubMock(): { calls: GithubCall[]; reset: () => void } {
  const calls: GithubCall[] = [];
  __testing.setDeps({
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

      // Comments list GET → empty array (no existing marker)
      if (method === "GET" && url.includes("/comments")) {
        return Promise.resolve(
          new Response(JSON.stringify([]), { status: 200 }),
        );
      }
      // /user GET → bot login
      if (method === "GET" && url.endsWith("/user")) {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "major-bot" }), { status: 200 }),
        );
      }
      // Comments POST → created
      if (method === "POST" && url.includes("/comments")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 1 }), { status: 201 }),
        );
      }
      // Issue PATCH → closed
      if (method === "PATCH") {
        return Promise.resolve(
          new Response(JSON.stringify({ number: 1, state: "closed" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "unmatched" }), { status: 599 }),
      );
    },
  });
  return {
    calls,
    reset: () => __testing.resetDeps(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Mock DB client for handlePullRequest + maybeAutoCloseBrief
// ────────────────────────────────────────────────────────────────────

interface BriefRow {
  id: number;
  status: string;
  source_issue_repo: string | null;
  source_issue_number: number | null;
  title: string | null;
  pr_url: string | null;
}

function makeMockClient(opts: {
  briefRow: BriefRow | null;
  latestRunId?: number | null;
}) {
  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: {
      op: string | null;
      filters: Record<string, string>;
    } = { op: null, filters: {} };

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
      insert(_row: unknown) {
        ctx.op = "insert";
        return builder;
      },
      eq(col: string, val: unknown) {
        ctx.filters[col] = String(val);
        return builder;
      },
      neq(_col: string, _val: unknown) {
        return builder;
      },
      order(_col: string, _opts?: unknown) {
        return builder;
      },
      limit(_n: number) {
        return builder;
      },
      maybeSingle() {
        if (table === "briefs" && ctx.op === "select") {
          return Promise.resolve({ data: opts.briefRow, error: null });
        }
        if (table === "runs" && ctx.op === "select") {
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
        if (table === "verification_results" && ctx.op === "select") {
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

// ────────────────────────────────────────────────────────────────────
// PR payload builders
// ────────────────────────────────────────────────────────────────────

const RECEIPT_BODY =
  "## Summary\n\nFix the bug.\n\n## Linked\n\nMajor-brief: 42\nRun: 99\n";

function buildClosedPrPayload(merged: boolean) {
  return {
    action: "closed",
    pull_request: {
      number: 10,
      html_url: "https://github.com/MioMarker/healthbite/pull/10",
      body: RECEIPT_BODY,
      merged,
      state: "closed",
      head: { sha: "abc123" },
      base: { sha: "def456" },
      mergeable: null,
      draft: false,
      requested_reviewers: [],
      requested_teams: [],
      additions: 5,
      deletions: 2,
      changed_files: 1,
      merged_by: merged ? { login: "alice" } : null,
      closed_by: !merged ? { login: "bob" } : null,
      user: { login: "charlie" },
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("ADR-011 merged PR: postResolutionAndClose called with closeReason 'completed'", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const brief: BriefRow = {
      id: 42,
      status: "ready-for-review",
      source_issue_repo: "MioMarker/healthbite",
      source_issue_number: 7,
      title: "Fix the thing",
      pr_url: null,
    };
    const client = makeMockClient({ briefRow: brief, latestRunId: 99 });
    await handlePullRequest(client, buildClosedPrPayload(true), "delivery-merged");

    const patchCall = calls.find((c) => c.method === "PATCH");
    assert(patchCall, "expected a PATCH call to close the issue");
    assert(patchCall.url.includes("MioMarker/healthbite/issues/7"), "PATCH must target the source issue");

    const patchBody = JSON.parse(patchCall.body ?? "{}") as {
      state?: string;
      state_reason?: string;
    };
    assertEquals(patchBody.state, "closed");
    assertEquals(patchBody.state_reason, "completed");
  } finally {
    reset();
  }
});

Deno.test("ADR-011 non-merged PR: postResolutionAndClose called with closeReason 'not_planned'", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const brief: BriefRow = {
      id: 42,
      status: "agent-running",
      source_issue_repo: "MioMarker/healthbite",
      source_issue_number: 7,
      title: "Fix the thing",
      pr_url: null,
    };
    const client = makeMockClient({ briefRow: brief, latestRunId: null });
    await handlePullRequest(client, buildClosedPrPayload(false), "delivery-closed");

    const patchCall = calls.find((c) => c.method === "PATCH");
    assert(patchCall, "expected a PATCH call to close the issue");

    const patchBody = JSON.parse(patchCall.body ?? "{}") as {
      state?: string;
      state_reason?: string;
    };
    assertEquals(patchBody.state, "closed");
    assertEquals(patchBody.state_reason, "not_planned");
  } finally {
    reset();
  }
});

Deno.test("ADR-011 no source_issue_repo: postResolutionAndClose NOT called", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const brief: BriefRow = {
      id: 42,
      status: "ready-for-review",
      source_issue_repo: null,
      source_issue_number: null,
      title: "No linked issue",
      pr_url: null,
    };
    const client = makeMockClient({ briefRow: brief });
    await handlePullRequest(client, buildClosedPrPayload(true), "delivery-no-issue");

    const patchCall = calls.find((c) => c.method === "PATCH");
    assertEquals(patchCall, undefined, "PATCH must NOT be called when source_issue_repo is null");
  } finally {
    reset();
  }
});

Deno.test("ADR-011 already-terminal brief: postResolutionAndClose NOT called", async () => {
  const { calls, reset } = installGithubMock();
  try {
    const brief: BriefRow = {
      id: 42,
      status: "done",
      source_issue_repo: "MioMarker/healthbite",
      source_issue_number: 7,
      title: "Already done",
      pr_url: null,
    };
    const client = makeMockClient({ briefRow: brief });
    await handlePullRequest(client, buildClosedPrPayload(true), "delivery-terminal");

    const patchCall = calls.find((c) => c.method === "PATCH");
    assertEquals(patchCall, undefined, "PATCH must NOT be called when brief is already terminal");
  } finally {
    reset();
  }
});
