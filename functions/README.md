# Major — Edge Functions

Major's API surface. One Supabase edge function per route, deployed to the
existing Supabase dev project (`nuihvxluxdpdjgkvtdih`) under the new
`major.*` schema. All functions are written in TypeScript for Deno Deploy.

## Layout

```
functions/
  _shared/
    auth.ts            authenticated user → service-role client + actor string
    cors.ts            CORS headers + preflight helper
    db.ts              service-role admin client builders
    idempotency.ts     deriveIdempotencyKey() per spec
    path_blocker.ts    pure path-glob + mass-rerank rule
    response.ts        jsonResponse / errorResponse with CORS
    webhook.ts         HMAC-SHA256 GitHub signature verification
  _sql/
    rpc_functions.sql  Postgres RPCs (claim_next_item, finalize_run,
                       apply_change_set, reaper_sweep). Owned alongside
                       functions/ because they're called as part of the API
                       surface, not as schema.
  major-create-triage-session/
  major-send-triage-message/
  major-finalize-triage-session/
  major-apply-change-set/
  major-list-items/
  major-get-item/
  major-claim-item/
  major-finalize-run/
  major-heartbeat/
  major-github-webhook/
  major-confirm-qa/
  major-reject-item/
  major-start-auto-triage/
  major-reaper/
  config.toml          per-function gateway settings (verify_jwt = false
                       for webhook + reaper)
  deno.json            compiler / import map
```

Every function dir has `index.ts` + `deno.json`. Each function exports a
single `Deno.serve(...)` handler.

## Environment variables

| Variable | Required by | Source |
|---|---|---|
| `SUPABASE_URL` | all functions | edge runtime — set automatically |
| `SUPABASE_SERVICE_ROLE_KEY` | all functions | edge runtime — set automatically |
| `GITHUB_WEBHOOK_SECRET` | `major-github-webhook` | set via `supabase secrets set GITHUB_WEBHOOK_SECRET=<value>`; matches the GitHub webhook configuration |
| `OPENAI_API_KEY` | `major-send-triage-message` (once LLM is wired) | set via `supabase secrets set OPENAI_API_KEY=<value>` |

## Deploy

Link to the dev project once:

```
npx -y supabase link --project-ref nuihvxluxdpdjgkvtdih
```

Apply the RPC migration (one-time, then any time `_sql/rpc_functions.sql`
changes):

```
SUPABASE_DB_PASSWORD=<password> npx -y supabase db execute \
  --file functions/_sql/rpc_functions.sql
```

Deploy each function independently. The supabase CLI automatically uploads
`config.toml` settings (so the webhook + reaper get `verify_jwt = false`):

```
npx -y supabase functions deploy major-create-triage-session
npx -y supabase functions deploy major-send-triage-message
npx -y supabase functions deploy major-finalize-triage-session
npx -y supabase functions deploy major-apply-change-set
npx -y supabase functions deploy major-list-items
npx -y supabase functions deploy major-get-item
npx -y supabase functions deploy major-claim-item
npx -y supabase functions deploy major-finalize-run
npx -y supabase functions deploy major-heartbeat
npx -y supabase functions deploy major-github-webhook --no-verify-jwt
npx -y supabase functions deploy major-confirm-qa
npx -y supabase functions deploy major-reject-item
npx -y supabase functions deploy major-start-auto-triage
npx -y supabase functions deploy major-reaper --no-verify-jwt
```

`--no-verify-jwt` is redundant for projects that pick up `config.toml`, but
kept here for clarity — webhooks + the reaper must never require a JWT.

## Local checks

`functions/deno.json` defines a top-level type-check task:

```
cd functions && deno task check
```

This runs `deno check **/*.ts` across every function and helper.

## pg_cron — scheduling the reaper

The reaper runs every 60 seconds. Set up a cron job in Postgres:

```sql
-- Run once on the dev project as a privileged role.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'major-reaper-60s',
  '*/1 * * * *',
  $$
  select net.http_post(
    url := 'https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1/major-reaper',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
```

Alternatively, `pg_cron` can call `major.reaper_sweep()` directly without
going through HTTP at all — that's strictly cheaper and keeps everything in
the database:

```sql
select cron.schedule(
  'major-reaper-direct-60s',
  '*/1 * * * *',
  $$select major.reaper_sweep();$$
);
```

The HTTP route exists so we can also poke the reaper manually (`curl -X POST
.../major-reaper`) when debugging.

## Atomicity strategy

Multi-statement transactions live in Postgres functions
(`_sql/rpc_functions.sql`), called from the edge layer via `supabase.rpc()`.
A function body is one transaction — any RAISE rolls back the whole apply.
This is necessary for:

- **Run Start Transaction** (`claim_next_item`): row-locked `SELECT … FOR
  UPDATE SKIP LOCKED`, status update, run insert, and Event inserts in one
  atomic step. The partial unique index on
  `runs(work_item_id) WHERE outcome='running'` enforces the Single Active
  Run Rule even if two runners race past the SKIP-LOCKED guard.
- **Run Finalization Transaction** (`finalize_run`): run update + verifications
  + artifacts + status transition + Events.
- **Change Set apply** (`apply_change_set`): each operation in
  `sequence_index` order; any RAISE rolls back every op so the store stays
  consistent.

The edge layer's job is request validation + path-blocker + auth — never
multi-row writes that need cross-row consistency.

## Authentication summary

| Function | Auth | Reason |
|---|---|---|
| User-facing (UI + Runner) | `_shared/auth.ts` Bearer token | RLS-blind operations need the service-role client; we still verify the JWT belongs to a real user via `auth.getUser(token)` |
| `major-github-webhook` | HMAC-SHA256 signature | GitHub doesn't send a Supabase JWT; the webhook secret is shared with GitHub |
| `major-reaper` | None | Called by pg_cron; no user-attributable identity |

Major has only two human users (the two devs). RLS is intentionally not
relied on for these endpoints — the service-role client + auth helper is the
authorization boundary. Any future `read-only public dashboard` use case
should add a separate function with explicit role logic, not relax the
`auth.ts` guard.

## Idempotency

Every Event insert (and most retryable writes) carries an idempotency key
derived per spec: `<work_item_id>:<event_type>:<source_actor>:<source_delivery_id>`.
The `events.idempotency_key` column has a UNIQUE constraint, so re-inserts
with the same key fail cleanly — `on conflict (idempotency_key) do nothing`
is the standard pattern in the RPCs.
