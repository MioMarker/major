# Supabase Edge Functions

Major's edge functions live under `supabase/functions/major-<name>/`. Each function has its own directory with `index.ts` and `deno.json`. Shared boilerplate (CORS, auth, response, DB helpers) is in `supabase/functions/_shared/`.

## `_shared/` is Required

Every function uses helpers from `supabase/functions/_shared/`:

| File | Purpose |
|---|---|
| `cors.ts` | `corsHeaders`, `handleOptions(req)` |
| `auth.ts` | `authenticate(req)` — returns `{ ok, client, user, userId }` or `{ ok: false, status, message }` |
| `response.ts` | `jsonResponse(data, status?)`, `errorResponse(message, status?)` — both apply CORS headers |
| `schemas/` | Zod schemas shared across functions (request bodies, webhook payloads, etc.) |
| `db/` | Typed query helpers backed by `db/types.ts` |

Don't reinvent any of these per function. If you find boilerplate creeping in, lift it into `_shared/`.

## Required Boilerplate

Every function:

1. Handles CORS preflight (OPTIONS) before any logic.
2. Validates auth if user-facing (or uses service-role explicitly with a comment explaining why).
3. Validates the request body via Zod.
4. Returns JSON via `jsonResponse` / `errorResponse` (never `Response.new` with hand-rolled headers).
5. Reads env vars via `Deno.env.get()` — never hardcoded.

Canonical shape:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleOptions } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { jsonResponse, errorResponse } from "../_shared/response.ts";
import { ClaimBriefRequest } from "../_shared/schemas/claim-brief.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return errorResponse(auth.message, auth.status);

    const parsed = ClaimBriefRequest.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.message, 400);

    const result = await runClaimTransaction(auth.client, parsed.data);
    return jsonResponse(result);
  } catch (error) {
    console.error("[MajorClaimBrief]", error);
    return errorResponse(error instanceof Error ? error.message : "Server error", 500);
  }
});
```

## JWT Verification per Function

Edge functions on Supabase have a platform-level JWT pre-check. Some Major functions need user JWT verification (most `major-*` UI-callers); others must be reachable without a user token (`major-github-webhook`, `major-reaper`).

Configure per function in `supabase/config.toml`:

```toml
[functions.major-github-webhook]
verify_jwt = false   # webhook is signed by GitHub; verifies signature inline

[functions.major-reaper]
verify_jwt = false   # invoked by pg_cron; uses service-role internally
```

The default (omitted) is `verify_jwt = true`. Don't disable JWT verification on a user-facing function; the gateway pre-check is a defense-in-depth layer.

## Idempotency on Every Event

**Every Event write requires an idempotency key.** Per `SPEC.md`, the key is `(brief_id, event_type, source_actor, source_delivery_id)`.

```ts
await client.from("events").insert({
  brief_id,
  event_type: "run-started",
  source_actor: "shell",
  source_actor_id: shell_id,
  idempotency_key: `${brief_id}:run-started:${shell_id}:${run_id}`,
  payload,
});
```

If the insert fails on the unique constraint: that's a duplicate; treat as a no-op success. Same rule applies to Verification Result writes, Run Finalization writes, and Change Operation apply records.

## Atomic Transactions for State Changes

Three operations MUST be atomic (single Postgres transaction, all-or-nothing):

### Run Start Transaction

`major-claim-brief` performs:

1. `UPDATE major.briefs SET status='agent-running' WHERE id=$1 AND status='ready-for-agent'` — atomic claim.
2. `INSERT INTO major.runs ... outcome='running'` — only succeeds if step 1 affected 1 row.
3. `INSERT INTO major.events (event_type='run-started', ...)` with idempotency key.
4. Return claim ticket.

If any step fails, the whole transaction rolls back. The Single Active Run Rule (partial unique index) is the second layer of defense.

### Run Finalization Transaction

`major-finalize-run` performs:

1. `UPDATE major.runs SET outcome='<terminal>', finalized_at=now() WHERE id=$1 AND outcome='running'` — only the holding Shell can finalize.
2. `INSERT INTO major.brief_artifacts ...` — produced artifacts.
3. `INSERT INTO major.verification_results ...` — verification outcomes.
4. `UPDATE major.briefs SET status='<next>'` — transition.
5. `INSERT INTO major.events (event_type='run-ended', ...)` with idempotency key.

All atomic. If the Shell's lease has expired between heartbeat and finalize, step 1 affects 0 rows and the whole transaction fails — the Shell aborts, having already lost the claim to the Reaper.

### Change Set Apply

`major-apply-change-set` performs all Change Operations in the set as one transaction. Any single op failure rolls back the whole set. Per-op idempotency keys prevent duplicate apply on retry.

## Logging

- Prefix every `console.error` and `console.log` with `[FunctionName]` (PascalCase).
- AI-call logs include model + prompt_version + latency.
- Never log full request bodies if they may contain user content. Log shape and identifiers (Brief id, Run id) instead.
- Webhook handlers log delivery id and event type at `info`; full payloads only on error and only with redaction.

## Imports

- Use `jsr:` imports for Deno packages. `https://esm.sh/` is acceptable when already established in a file; don't mix specifier styles for the same package.
- Pin versions when they matter. Don't import bare URLs without a version.

## Status codes

- `200` success
- `400` bad request (schema validation, malformed payload)
- `401` unauthorized (missing/invalid auth, missing webhook signature)
- `404` not found
- `409` conflict (Run claim race, idempotency-key duplicate)
- `429` rate limit (when we add backpressure)
- `500` server error (unexpected; log full context)

## Streaming

If we ever stream (e.g., a future Triage Session token-stream): use `ReadableStream` with SSE format. CORS headers still apply via `_shared/`.
