// major-github-webhook/handle-pr.test.ts
//
// Run: deno test --allow-none supabase/functions/major-github-webhook/handle-pr.test.ts
//
// Tests for handlePullRequest (F-17a/b/c) and KNOWN_CHECK_NAMES (F-17a).

import { assert, assertEquals } from "jsr:@std/assert@^0.226.0";
import { handlePullRequest } from "./index.ts";

// ────────────────────────────────────────────────────────────────────
// F-17a: KNOWN_CHECK_NAMES membership test — verify via source read
// ────────────────────────────────────────────────────────────────────

Deno.test("F-17a: KNOWN_CHECK_NAMES includes tachikoma-implementer", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(
    src.includes('"tachikoma-implementer"'),
    'index.ts must include "tachikoma-implementer" in KNOWN_CHECK_NAMES',
  );
});

// ────────────────────────────────────────────────────────────────────
// Mock client — records DB calls made by handlePullRequest
// ────────────────────────────────────────────────────────────────────

type Recorded =
  | { kind: "briefs-update"; updateFields: Record<string, unknown>; filters: Record<string, string> }
  | { kind: "event-insert"; row: Record<string, unknown> }
  | { kind: "telemetry-insert"; row: Record<string, unknown> }
  | { kind: "other"; table: string; op: string };

interface MockOpts {
  parsedBriefId?: number | null;
}

function makeMockClient(_opts: MockOpts = {}) {
  const recorded: Recorded[] = [];

  // deno-lint-ignore no-explicit-any
  const from = (table: string): any => {
    const ctx: {
      op: "update" | "insert" | null;
      updateFields: Record<string, unknown>;
      filters: Record<string, string>;
      insertRow: Record<string, unknown>;
    } = { op: null, updateFields: {}, filters: {}, insertRow: {} };

    // deno-lint-ignore no-explicit-any
    const builder: any = {
      update(fields: Record<string, unknown>) {
        ctx.op = "update";
        ctx.updateFields = { ...fields };
        return builder;
      },
      insert(row: Record<string, unknown>) {
        ctx.op = "insert";
        ctx.insertRow = { ...row };
        return builder;
      },
      eq(col: string, val: unknown) {
        ctx.filters[col] = String(val);
        return builder;
      },
      select(_cols?: string) {
        return builder;
      },
      // maybeSingle — used by maybeAutoCloseBrief; return null data so it short-circuits
      maybeSingle(): Promise<{ data: null; error: null }> {
        return Promise.resolve({ data: null, error: null });
      },
      // thenable — most inserts/updates are awaited directly
      then(
        resolve: (val: { data: unknown; error: null }) => void,
        _reject: (err: unknown) => void,
      ) {
        if (table === "briefs" && ctx.op === "update") {
          recorded.push({
            kind: "briefs-update",
            updateFields: { ...ctx.updateFields },
            filters: { ...ctx.filters },
          });
        } else if (table === "events" && ctx.op === "insert") {
          recorded.push({ kind: "event-insert", row: { ...ctx.insertRow } });
        } else if (table === "telemetry_records" && ctx.op === "insert") {
          recorded.push({ kind: "telemetry-insert", row: { ...ctx.insertRow } });
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
// Payload builders
// ────────────────────────────────────────────────────────────────────

function buildPrPayload(opts: {
  action?: string;
  prNumber?: number;
  prBody?: string;
  merged?: boolean;
  prState?: string;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  requestedReviewers?: unknown[];
  draft?: boolean;
}) {
  const action = opts.action ?? "opened";
  const merged = opts.merged ?? false;
  const prState = opts.prState ?? "open";

  return {
    action,
    pull_request: {
      number: opts.prNumber ?? 1,
      html_url: `https://github.com/MioMarker/major/pull/${opts.prNumber ?? 1}`,
      body: opts.prBody ?? null,
      merged,
      state: prState,
      head: { sha: "abc123" },
      base: { sha: "def456" },
      mergeable: true,
      draft: opts.draft ?? false,
      requested_reviewers: opts.requestedReviewers ?? [],
      requested_teams: [],
      additions: opts.additions ?? 10,
      deletions: opts.deletions ?? 5,
      changed_files: opts.changedFiles ?? 3,
    },
  };
}

// parseBriefIdFromBody requires the receipt to be inside a `## Linked` section.
const RECEIPT_BODY = "## Summary\n\nSome PR description.\n\n## Linked\n\nMajor-brief: 42\nRun: 12345\n";
const NO_RECEIPT_BODY = "This PR has no correlation receipt";

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

Deno.test("F-17b: PR with valid receipt → briefs update includes pr_derived_facts", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({ prBody: RECEIPT_BODY, action: "opened" });
  await handlePullRequest(client, payload, "delivery-1");

  const update = recorded.find((r) => r.kind === "briefs-update");
  assert(update, "expected briefs-update to be recorded");
  const fields = update.updateFields;
  assert("pr_derived_facts" in fields, "update must include pr_derived_facts");
  const facts = fields.pr_derived_facts as Record<string, unknown>;
  assert("mergeable" in facts, "pr_derived_facts must include mergeable");
  assert("draft" in facts, "pr_derived_facts must include draft");
  assert("requested_reviewer_count" in facts, "pr_derived_facts must include requested_reviewer_count");
  assert("additions" in facts, "pr_derived_facts must include additions");
  assert("deletions" in facts, "pr_derived_facts must include deletions");
  assert("changed_files" in facts, "pr_derived_facts must include changed_files");
});

Deno.test("F-17b: PR with valid receipt → briefs update also includes pr_status and pr_url", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({ prBody: RECEIPT_BODY, action: "opened" });
  await handlePullRequest(client, payload, "delivery-2");

  const update = recorded.find((r) => r.kind === "briefs-update");
  assert(update, "expected briefs-update");
  assert("pr_status" in update.updateFields, "update must include pr_status");
  assert("pr_url" in update.updateFields, "update must include pr_url");
  assertEquals(update.filters["id"], "42");
});

Deno.test("F-17c: PR with no receipt → inserts Telemetry Record, does NOT update briefs", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({ prBody: NO_RECEIPT_BODY, action: "opened", prNumber: 99 });
  await handlePullRequest(client, payload, "delivery-no-receipt");

  // Must NOT update briefs
  const update = recorded.find((r) => r.kind === "briefs-update");
  assertEquals(update, undefined, "briefs must NOT be updated when receipt is missing");

  // Must insert telemetry
  const telemetry = recorded.find((r) => r.kind === "telemetry-insert");
  assert(telemetry, "expected telemetry-insert for no-receipt PR");
  assertEquals(telemetry.row.observation_type, "pr-no-receipt");
  assertEquals(telemetry.row.brief_id, null);
  assertEquals(telemetry.row.run_id, null);
});

Deno.test("F-17c: telemetry record includes pr_number and delivery in payload", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({ prBody: NO_RECEIPT_BODY, prNumber: 77 });
  await handlePullRequest(client, payload, "delivery-xyz");

  const telemetry = recorded.find((r) => r.kind === "telemetry-insert");
  assert(telemetry, "expected telemetry-insert");
  const telPayload = telemetry.row.payload as Record<string, unknown>;
  assertEquals(telPayload.pr_number, 77);
  assertEquals(telPayload.delivery, "delivery-xyz");
});

Deno.test("F-17c: telemetry idempotency key derived from delivery", async () => {
  const { client: c1, recorded: r1 } = makeMockClient();
  const { client: c2, recorded: r2 } = makeMockClient();
  const payload = buildPrPayload({ prBody: NO_RECEIPT_BODY, prNumber: 5 });

  await handlePullRequest(c1, payload, "same-delivery");
  await handlePullRequest(c2, payload, "same-delivery");

  const t1 = r1.find((r) => r.kind === "telemetry-insert");
  const t2 = r2.find((r) => r.kind === "telemetry-insert");
  assert(t1 && t2, "both calls must insert telemetry");
  assertEquals(
    t1.row.idempotency_key,
    t2.row.idempotency_key,
    "same delivery must produce same idempotency key",
  );
});

Deno.test("PR with valid receipt + opened action → event inserted with correct type", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({ prBody: RECEIPT_BODY, action: "opened" });
  await handlePullRequest(client, payload, "delivery-3");

  const event = recorded.find((r) => r.kind === "event-insert");
  assert(event, "expected event-insert");
  assertEquals(event.row.type, "pr-opened");
  assertEquals(event.row.actor, "integration:github");
  assertEquals(event.row.brief_id, 42);
});

// ─────────────────────────────────────────────────────────────────
// F-17: pull_request.closed writes pr_derived_facts (regression for F-17b)
// ─────────────────────────────────────────────────────────────────

Deno.test("F-17: pull_request.closed (not merged) → pr_derived_facts written, pr_status=closed", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({
    prBody: RECEIPT_BODY,
    action: "closed",
    merged: false,
    prState: "closed",
    additions: 20,
    deletions: 5,
    changedFiles: 2,
    requestedReviewers: [{ login: "dev-a" }],
  });
  await handlePullRequest(client, payload, "delivery-closed-1");

  const update = recorded.find((r) => r.kind === "briefs-update");
  assert(update, "expected briefs-update on closed action");

  // pr_derived_facts must be written (F-17b regression: closed action must
  // go through the same update path as opened/reopened).
  assert("pr_derived_facts" in update.updateFields, "pr_derived_facts must be in update");
  const facts = update.updateFields.pr_derived_facts as Record<string, unknown>;
  assertEquals(facts.additions, 20);
  assertEquals(facts.deletions, 5);
  assertEquals(facts.changed_files, 2);
  assertEquals(facts.requested_reviewer_count, 1);

  // pr_status must reflect the non-merged close.
  assertEquals(update.updateFields.pr_status, "closed");
});

Deno.test("F-17: pull_request.closed (merged) → pr_status=merged, pr_derived_facts written", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({
    prBody: RECEIPT_BODY,
    action: "closed",
    merged: true,
    prState: "closed",
  });
  await handlePullRequest(client, payload, "delivery-merged-1");

  const update = recorded.find((r) => r.kind === "briefs-update");
  assert(update, "expected briefs-update on merged closed action");
  assertEquals(update.updateFields.pr_status, "merged");
  assert("pr_derived_facts" in update.updateFields, "pr_derived_facts must be in update on merge");
});

Deno.test("F-17: pull_request.closed → event type is pr-closed", async () => {
  const { client, recorded } = makeMockClient();
  const payload = buildPrPayload({
    prBody: RECEIPT_BODY,
    action: "closed",
    merged: false,
    prState: "closed",
  });
  await handlePullRequest(client, payload, "delivery-closed-event");

  const event = recorded.find((r) => r.kind === "event-insert");
  assert(event, "expected event-insert on closed action");
  assertEquals(event.row.type, "pr-closed");
});
