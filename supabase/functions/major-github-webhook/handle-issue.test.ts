// handle-issue.test.ts — fixture-based tests for ADR 010's inbound trigger.
//
// Run: deno test --allow-none supabase/functions/major-github-webhook/handle-issue.test.ts
// (no network/env needed — `index.ts` guards `Deno.serve` with
// `import.meta.main`, so importing it here does not bind a port.)
//
// Coverage targets the acceptance criteria for ADR 010:
//   1. dispatches `X-GitHub-Event: issues` → `handleIssue()`
//      (verified by `handleIssue` being importable + the dispatch line in
//      `index.ts` source)
//   2. opened + `major:triage` label + human sender + watched repo → triggers
//   3. opened without `major:triage` label → skips
//   4. opened with bot sender → skips
//   5. opened on disallowed repo → skips
//   6. labeled with `major:triage` on open issue → triggers
//   7. labeled with a different label → skips
//   8. opened twice on the same issue → second call is a no-op (idempotency)
//   9. closed issue → skips

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { handleIssue } from "./index.ts";

// ────────────────────────────────────────────────────────────────────
// Mock Supabase client — records every `from(table).{select|insert}` call
// and the chained filters / payloads. Lets the test assert what the
// handler wrote without touching a real database.
// ────────────────────────────────────────────────────────────────────

type Recorded =
  | {
    kind: "session-lookup";
    filters: Record<string, string>;
    selected: string;
  }
  | {
    kind: "session-insert";
    row: Record<string, unknown>;
  }
  | {
    kind: "event-insert";
    row: Record<string, unknown>;
  }
  | {
    kind: "other";
    table: string;
    op: "select" | "insert";
  };

interface MockOptions {
  existingSession?: { id: number } | null;
  newSessionId?: number;
}

function makeMockClient(opts: MockOptions = {}) {
  const recorded: Recorded[] = [];
  const existingSession = opts.existingSession ?? null;
  const newSessionId = opts.newSessionId ?? 9001;

  // deno-lint-ignore no-explicit-any -- test stub mirroring supabase-js's
  // fluent builder; the production code typing is widened to `any` schema.
  const from = (table: string): any => {
    const ctx: {
      table: string;
      op: "select" | "insert" | null;
      filters: Record<string, string>;
      row: Record<string, unknown> | null;
      selected: string;
    } = { table, op: null, filters: {}, row: null, selected: "" };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      select(cols?: string) {
        if (ctx.op === null) ctx.op = "select";
        if (cols !== undefined) ctx.selected = cols;
        return builder;
      },
      insert(row: Record<string, unknown>) {
        ctx.op = "insert";
        ctx.row = row;
        return builder;
      },
      eq(col: string, val: unknown) {
        ctx.filters[col] = String(val);
        return builder;
      },
      limit(_n: number) {
        return builder;
      },
      maybeSingle() {
        recordCurrent();
        if (ctx.table === "triage_sessions" && ctx.op === "select") {
          return Promise.resolve({ data: existingSession, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() {
        recordCurrent();
        if (ctx.table === "triage_sessions" && ctx.op === "insert") {
          return Promise.resolve({ data: { id: newSessionId }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // The events-insert call shape in production code is
      // `client.from("events").insert(row).select()` — awaited directly,
      // no terminal `.single()`. Implement `then` so the builder is itself
      // a thenable, matching supabase-js's PostgrestBuilder shape.
      then(
        resolve: (val: { data: unknown; error: null }) => void,
        _reject: (err: unknown) => void,
      ) {
        recordCurrent();
        resolve({ data: null, error: null });
      },
    };

    function recordCurrent() {
      if (ctx.table === "triage_sessions" && ctx.op === "select") {
        recorded.push({
          kind: "session-lookup",
          filters: { ...ctx.filters },
          selected: ctx.selected,
        });
      } else if (ctx.table === "triage_sessions" && ctx.op === "insert") {
        recorded.push({ kind: "session-insert", row: ctx.row ?? {} });
      } else if (ctx.table === "events" && ctx.op === "insert") {
        recorded.push({ kind: "event-insert", row: ctx.row ?? {} });
      } else {
        recorded.push({ kind: "other", table: ctx.table, op: ctx.op ?? "select" });
      }
    }

    return builder;
  };

  return { client: { from } as never, recorded };
}

// ────────────────────────────────────────────────────────────────────
// Payload builders — keep test cases focused on the gate condition under
// test rather than re-spelling the full GitHub payload each time.
// ────────────────────────────────────────────────────────────────────

interface IssuePayloadOpts {
  action: "opened" | "labeled" | "closed";
  repo?: string;
  senderType?: "User" | "Bot";
  senderLogin?: string;
  issueNumber?: number;
  issueState?: "open" | "closed";
  issueLabels?: Array<{ name: string }>;
  addedLabel?: string;
}

function buildIssuePayload(opts: IssuePayloadOpts): Record<string, unknown> {
  const repo = opts.repo ?? "MioMarker/major";
  const issue = {
    number: opts.issueNumber ?? 123,
    title: "Test issue",
    body: "Test body",
    state: opts.issueState ?? "open",
    html_url: `https://github.com/${repo}/issues/${opts.issueNumber ?? 123}`,
    created_at: "2026-05-10T12:00:00Z",
    user: { login: "human-reporter" },
    labels: opts.issueLabels ?? [],
  };
  const payload: Record<string, unknown> = {
    action: opts.action,
    issue,
    repository: { full_name: repo },
    sender: {
      login: opts.senderLogin ?? "human-reporter",
      type: opts.senderType ?? "User",
    },
  };
  if (opts.action === "labeled" && opts.addedLabel !== undefined) {
    payload.label = { name: opts.addedLabel };
  }
  return payload;
}

// ────────────────────────────────────────────────────────────────────
// AC1: `index.ts` dispatches `X-GitHub-Event: issues` to `handleIssue`
// ────────────────────────────────────────────────────────────────────

Deno.test("AC1: index.ts dispatches `issues` event to handleIssue", async () => {
  // Two-part verification:
  //   (a) `handleIssue` is exported from `./index.ts` (the import at the
  //       top of this file succeeded — typeof check confirms function).
  //   (b) `index.ts` source includes the dispatch line that routes
  //       X-GitHub-Event: "issues" to `handleIssue(client, payload, delivery)`.
  assertEquals(typeof handleIssue, "function");
  const src = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(
    src.includes(`event === "issues"`),
    "index.ts must branch on event === \"issues\"",
  );
  assert(
    src.includes("handleIssue(client, payload, delivery)"),
    "index.ts must dispatch to handleIssue(client, payload, delivery)",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC2: opened + label + human + watched repo → triggers
// ────────────────────────────────────────────────────────────────────

Deno.test("AC2: opened with major:triage label, human sender, watched repo → creates Triage Session", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "opened",
    repo: "MioMarker/healthbite",
    issueNumber: 42,
    issueLabels: [{ name: "bug" }, { name: "major:triage" }],
  });
  await handleIssue(client, payload, "delivery-abc");

  // Idempotency lookup happened first.
  const lookup = recorded.find((r) => r.kind === "session-lookup");
  assert(lookup, "expected session-lookup to occur");
  assertEquals(
    lookup.filters["trigger_payload->>source_issue_repo"],
    "MioMarker/healthbite",
  );
  assertEquals(
    lookup.filters["trigger_payload->>source_issue_number"],
    "42",
  );
  assertEquals(lookup.filters["status"], "open");

  // Session inserted with the right trigger_payload shape.
  const sessionInsert = recorded.find((r) => r.kind === "session-insert");
  assert(sessionInsert, "expected session-insert to occur");
  assertEquals(sessionInsert.row.initiator_actor, "integration:github");
  assertEquals(sessionInsert.row.status, "open");
  const triggerPayload = sessionInsert.row.trigger_payload as Record<string, unknown>;
  assertEquals(triggerPayload.source_issue_repo, "MioMarker/healthbite");
  assertEquals(triggerPayload.source_issue_number, 42);
  assertEquals(triggerPayload.github_delivery, "delivery-abc");
  assertEquals(triggerPayload.source_issue_author_login, "human-reporter");

  // Event emitted with the documented idempotency-key shape.
  const eventInsert = recorded.find((r) => r.kind === "event-insert");
  assert(eventInsert, "expected event-insert to occur");
  assertEquals(eventInsert.row.type, "triage-session-created");
  assertEquals(eventInsert.row.actor, "integration:github");
  assertEquals(eventInsert.row.brief_id, null);
  assertEquals(
    eventInsert.row.idempotency_key,
    "null:triage-session-created:integration:github:delivery-abc",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC3: opened without label → skips
// ────────────────────────────────────────────────────────────────────

Deno.test("AC3: opened without major:triage label → no Session, no Event", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "opened",
    issueLabels: [{ name: "bug" }, { name: "question" }],
  });
  await handleIssue(client, payload, "delivery-no-label");

  assertEquals(
    recorded.filter((r) => r.kind === "session-insert").length,
    0,
    "no session should be inserted",
  );
  assertEquals(
    recorded.filter((r) => r.kind === "event-insert").length,
    0,
    "no event should be inserted",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC4: opened with bot sender → skips
// ────────────────────────────────────────────────────────────────────

Deno.test("AC4: opened with Bot sender → no Session, no Event", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "opened",
    senderType: "Bot",
    senderLogin: "dependabot[bot]",
    issueLabels: [{ name: "major:triage" }],
  });
  await handleIssue(client, payload, "delivery-bot");

  assertEquals(recorded.filter((r) => r.kind === "session-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "event-insert").length, 0);
  // The handler must short-circuit before the DB lookup — sender filter is
  // cheap and must precede any DB work.
  assertEquals(recorded.filter((r) => r.kind === "session-lookup").length, 0);
});

// ────────────────────────────────────────────────────────────────────
// AC5: opened on disallowed repo → skips
// ────────────────────────────────────────────────────────────────────

Deno.test("AC5: opened on a repo outside the allowlist → no Session, no Event", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "opened",
    repo: "MioMarker/not-watched",
    issueLabels: [{ name: "major:triage" }],
  });
  await handleIssue(client, payload, "delivery-bad-repo");

  assertEquals(recorded.filter((r) => r.kind === "session-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "event-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "session-lookup").length, 0);
});

// ────────────────────────────────────────────────────────────────────
// AC6: labeled with major:triage on open issue → triggers
// ────────────────────────────────────────────────────────────────────

Deno.test("AC6: action=labeled with major:triage on an open issue → creates Triage Session", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "labeled",
    repo: "MioMarker/major",
    issueNumber: 77,
    issueState: "open",
    issueLabels: [{ name: "major:triage" }],
    addedLabel: "major:triage",
  });
  await handleIssue(client, payload, "delivery-labeled");

  const sessionInsert = recorded.find((r) => r.kind === "session-insert");
  assert(sessionInsert, "expected session-insert to occur on labeled trigger");
  const triggerPayload = sessionInsert.row.trigger_payload as Record<string, unknown>;
  assertEquals(triggerPayload.source_issue_repo, "MioMarker/major");
  assertEquals(triggerPayload.source_issue_number, 77);

  const eventInsert = recorded.find((r) => r.kind === "event-insert");
  assert(eventInsert, "expected event-insert to occur on labeled trigger");
  assertEquals(eventInsert.row.type, "triage-session-created");
});

// ────────────────────────────────────────────────────────────────────
// AC7: labeled with a different label → skips
// ────────────────────────────────────────────────────────────────────

Deno.test("AC7: action=labeled with a non-triage label → no Session, no Event", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "labeled",
    issueState: "open",
    issueLabels: [{ name: "bug" }],
    addedLabel: "bug",
  });
  await handleIssue(client, payload, "delivery-other-label");

  assertEquals(recorded.filter((r) => r.kind === "session-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "event-insert").length, 0);
});

// ────────────────────────────────────────────────────────────────────
// AC8: opened twice on the same issue → second call is a no-op
// ────────────────────────────────────────────────────────────────────

Deno.test("AC8: redelivery (open Session already exists) → no-op, no new Session/Event", async () => {
  // First call would insert (test elsewhere). This test simulates the
  // post-insert state: the lookup returns an existing open Session row.
  const { client, recorded } = makeMockClient({
    existingSession: { id: 9001 },
  });
  const payload = buildIssuePayload({
    action: "opened",
    repo: "MioMarker/healthbite",
    issueNumber: 42,
    issueLabels: [{ name: "major:triage" }],
  });
  await handleIssue(client, payload, "delivery-redelivery");

  // Lookup must run (cheap gates passed). Insert and event must NOT run.
  const lookups = recorded.filter((r) => r.kind === "session-lookup");
  assertEquals(lookups.length, 1, "exactly one lookup must run");
  assertEquals(recorded.filter((r) => r.kind === "session-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "event-insert").length, 0);
});

// ────────────────────────────────────────────────────────────────────
// AC9: closed issue → skips
// ────────────────────────────────────────────────────────────────────

Deno.test("AC9: action=closed → no Session, no Event (lifecycle ignored)", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildIssuePayload({
    action: "closed",
    issueState: "closed",
    issueLabels: [{ name: "major:triage" }],
  });
  await handleIssue(client, payload, "delivery-closed");

  assertEquals(recorded.filter((r) => r.kind === "session-insert").length, 0);
  assertEquals(recorded.filter((r) => r.kind === "event-insert").length, 0);
  // The handler short-circuits before the DB lookup because the trigger
  // condition for action='closed' is never satisfied.
  assertEquals(recorded.filter((r) => r.kind === "session-lookup").length, 0);
});
