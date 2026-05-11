// _shared/github-issue.test.ts — tests for postResolutionAndClose (ADR 011).
//
// Run: deno test supabase/functions/_shared/github-issue.test.ts
//
// Tests inject a fake env reader and a route-table fetch via the module's
// __testing seam so no env / net permissions are required.

import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^0.226.0";
import {
  __testing,
  postResolutionAndClose,
  type PostResolutionArgs,
} from "./github-issue.ts";

// ────────────────────────────────────────────────────────────────────
// Test harness — route-table fetch mock
// ────────────────────────────────────────────────────────────────────

type Route = {
  match: (url: string, method: string) => boolean;
  respond: (call: FetchCall) => { status: number; body: unknown };
};

type FetchCall = { url: string; method: string; body: string | undefined };

function installMock(routes: Route[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  __testing.setDeps({
    env: (key) => {
      if (key === "GITHUB_APP_TOKEN") return "test-token";
      return undefined;
    },
    fetch: (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      const i = (init ?? {}) as { method?: string; body?: unknown };
      const method = (i.method ?? "GET").toUpperCase();
      const body = typeof i.body === "string" ? i.body : undefined;
      const call: FetchCall = { url, method, body };
      calls.push(call);
      for (const r of routes) {
        if (r.match(url, method)) {
          const resp = r.respond(call);
          return Promise.resolve(
            new Response(JSON.stringify(resp.body), {
              status: resp.status,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "no mock route" }), {
          status: 599,
        }),
      );
    },
  });
  return { calls };
}

function cleanup(): void {
  __testing.resetDeps();
}

function baseArgs(
  overrides: Partial<PostResolutionArgs> = {},
): PostResolutionArgs {
  return {
    issueRepo: "MioMarker/major",
    issueNumber: 7,
    brief: {
      id: 42,
      title: "Add path-blocker glob editor to Settings",
      pr_url: "https://github.com/MioMarker/major/pull/48",
      status: "done",
    },
    verificationResults: [
      { check_name: "tachikoma-implementer", outcome: "pass", required: true },
      { check_name: "tsc-noemit", outcome: "pass", required: true },
      { check_name: "ci-rollup", outcome: "pass", required: false },
    ],
    closeReason: "completed",
    ...overrides,
  };
}

// Common matchers
const isListComments = (u: string, m: string) =>
  m === "GET" && u.includes("/issues/") && u.includes("/comments?");
const isGetUser = (u: string, m: string) =>
  m === "GET" && u.endsWith("/user");
const isPostComment = (u: string, m: string) =>
  m === "POST" && u.endsWith("/comments");
const isPatchIssue = (u: string, m: string) =>
  m === "PATCH" && /\/issues\/\d+$/.test(u);

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("done + PR + verifications: renders full body, POST then PATCH", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "some-account" } }),
    },
    { match: isPostComment, respond: () => ({ status: 201, body: { id: 1 } }) },
    { match: isPatchIssue, respond: () => ({ status: 200, body: { id: 7 } }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result, { ok: true });

    const postCall = mock.calls.find((c) => isPostComment(c.url, c.method));
    const patchCall = mock.calls.find((c) => isPatchIssue(c.url, c.method));
    if (!postCall || !patchCall) {
      throw new Error("expected POST and PATCH calls");
    }

    const postedBody = JSON.parse(postCall.body ?? "{}").body as string;
    assertStringIncludes(postedBody, "Resolved by Major Brief #42 — **done**");
    assertStringIncludes(
      postedBody,
      "> Add path-blocker glob editor to Settings",
    );
    assertStringIncludes(
      postedBody,
      "**Pull Request:** [MioMarker/major#48](https://github.com/MioMarker/major/pull/48)",
    );
    assertStringIncludes(postedBody, "**Verification:**");
    assertStringIncludes(
      postedBody,
      "- tachikoma-implementer: pass (required: yes)",
    );
    assertStringIncludes(postedBody, "- tsc-noemit: pass (required: yes)");
    assertStringIncludes(postedBody, "- ci-rollup: pass (required: no)");
    assertStringIncludes(postedBody, "— posted by Major (some-account)");

    // Required checks appear before advisory checks.
    const idxRequired = postedBody.indexOf("- tsc-noemit:");
    const idxAdvisory = postedBody.indexOf("- ci-rollup:");
    assertEquals(idxRequired < idxAdvisory, true);

    // No Reason block on done.
    assertEquals(postedBody.includes("**Reason:**"), false);

    const patched = JSON.parse(patchCall.body ?? "{}");
    assertEquals(patched.state, "closed");
    assertEquals(patched.state_reason, "completed");
  } finally {
    cleanup();
  }
});

Deno.test("wontfix + rejectionReason: Reason block present, no PR block, POST + PATCH", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "some-account" } }),
    },
    { match: isPostComment, respond: () => ({ status: 201, body: { id: 2 } }) },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs({
      brief: {
        id: 51,
        title: "Spike on cross-repo Brief support",
        pr_url: null,
        status: "wontfix",
      },
      verificationResults: [],
      closeReason: "not_planned",
      rejectionReason:
        "PR closed without merging by jonathan-sells; spike concluded the feature is out of scope for v1.",
    }));
    assertEquals(result, { ok: true });

    const postCall = mock.calls.find((c) => isPostComment(c.url, c.method));
    const patchCall = mock.calls.find((c) => isPatchIssue(c.url, c.method));
    if (!postCall || !patchCall) {
      throw new Error("expected POST and PATCH calls");
    }

    const postedBody = JSON.parse(postCall.body ?? "{}").body as string;
    assertStringIncludes(
      postedBody,
      "Resolved by Major Brief #51 — **wontfix**",
    );
    assertStringIncludes(
      postedBody,
      "**Reason:** PR closed without merging by jonathan-sells",
    );
    // No PR block.
    assertEquals(postedBody.includes("**Pull Request:**"), false);
    // No Verification block (empty input).
    assertEquals(postedBody.includes("**Verification:**"), false);

    const patched = JSON.parse(patchCall.body ?? "{}");
    assertEquals(patched.state, "closed");
    assertEquals(patched.state_reason, "not_planned");
  } finally {
    cleanup();
  }
});

Deno.test("empty verifications: verification block omitted", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "bot" } }),
    },
    { match: isPostComment, respond: () => ({ status: 201, body: {} }) },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs({
      verificationResults: [],
    }));
    assertEquals(result, { ok: true });

    const postCall = mock.calls.find((c) => isPostComment(c.url, c.method));
    if (!postCall) throw new Error("expected POST call");
    const postedBody = JSON.parse(postCall.body ?? "{}").body as string;
    assertEquals(postedBody.includes("**Verification:**"), false);
    // PR block still present since pr_url is set.
    assertStringIncludes(postedBody, "**Pull Request:**");
  } finally {
    cleanup();
  }
});

Deno.test("existing marker comment: POST skipped, PATCH still called", async () => {
  const mock = installMock([
    {
      match: isListComments,
      respond: () => ({
        status: 200,
        body: [
          { body: "Some unrelated earlier comment." },
          {
            body:
              "Resolved by Major Brief #42 — **done**\n\n> Earlier resolution.",
          },
        ],
      }),
    },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result, { ok: true });

    // POST should NOT have been called.
    assertEquals(
      mock.calls.find((c) => isPostComment(c.url, c.method)),
      undefined,
    );
    // GET /user should NOT have been called either (we skipped rendering).
    assertEquals(
      mock.calls.find((c) => isGetUser(c.url, c.method)),
      undefined,
    );
    // PATCH should have been called.
    assertEquals(
      mock.calls.find((c) => isPatchIssue(c.url, c.method)) !== undefined,
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("substring-id collision: #4 marker does NOT match for Brief #42", async () => {
  // A comment that resolved Brief #4 must NOT short-circuit Brief #42's
  // resolution. Guards against `String.includes` substring matching.
  const mock = installMock([
    {
      match: isListComments,
      respond: () => ({
        status: 200,
        body: [
          { body: "Resolved by Major Brief #4 — **done**" },
        ],
      }),
    },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "bot" } }),
    },
    { match: isPostComment, respond: () => ({ status: 201, body: {} }) },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result, { ok: true });
    // POST must have run — marker for #4 must not satisfy #42's idempotency.
    assertEquals(
      mock.calls.find((c) => isPostComment(c.url, c.method)) !== undefined,
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("POST fails: returns ok:false with error, PATCH not called", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "bot" } }),
    },
    {
      match: isPostComment,
      respond: () => ({ status: 502, body: { message: "Bad Gateway" } }),
    },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "comment POST failed");
    assertStringIncludes(result.error ?? "", "502");
    // PATCH must NOT have been called after POST failure.
    assertEquals(
      mock.calls.find((c) => isPatchIssue(c.url, c.method)),
      undefined,
    );
  } finally {
    cleanup();
  }
});

Deno.test("PATCH fails after POST: returns ok:false with error", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    {
      match: isGetUser,
      respond: () => ({ status: 200, body: { login: "bot" } }),
    },
    { match: isPostComment, respond: () => ({ status: 201, body: {} }) },
    {
      match: isPatchIssue,
      respond: () => ({ status: 422, body: { message: "Unprocessable" } }),
    },
  ]);
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "issue PATCH failed");
    assertStringIncludes(result.error ?? "", "422");
    // POST must have been called (we got far enough to reach PATCH).
    assertEquals(
      mock.calls.find((c) => isPostComment(c.url, c.method)) !== undefined,
      true,
    );
  } finally {
    cleanup();
  }
});

Deno.test("missing GITHUB_APP_TOKEN: returns ok:false without any network calls", async () => {
  const mock = installMock([
    { match: () => true, respond: () => ({ status: 500, body: {} }) },
  ]);
  // Override env to return undefined for the token.
  __testing.setDeps({
    env: () => undefined,
  });
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result.ok, false);
    assertStringIncludes(result.error ?? "", "GITHUB_APP_TOKEN");
    assertEquals(mock.calls.length, 0);
  } finally {
    cleanup();
  }
});

Deno.test("GITHUB_APP_BOT_LOGIN override: skips GET /user", async () => {
  const mock = installMock([
    { match: isListComments, respond: () => ({ status: 200, body: [] }) },
    { match: isPostComment, respond: () => ({ status: 201, body: {} }) },
    { match: isPatchIssue, respond: () => ({ status: 200, body: {} }) },
  ]);
  __testing.setDeps({
    env: (key) => {
      if (key === "GITHUB_APP_TOKEN") return "test-token";
      if (key === "GITHUB_APP_BOT_LOGIN") return "major-bot";
      return undefined;
    },
  });
  try {
    const result = await postResolutionAndClose(baseArgs());
    assertEquals(result, { ok: true });
    assertEquals(
      mock.calls.find((c) => isGetUser(c.url, c.method)),
      undefined,
    );
    const postCall = mock.calls.find((c) => isPostComment(c.url, c.method));
    if (!postCall) throw new Error("expected POST");
    const body = JSON.parse(postCall.body ?? "{}").body as string;
    assertStringIncludes(body, "— posted by Major (major-bot)");
  } finally {
    cleanup();
  }
});
