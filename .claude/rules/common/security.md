# Security

Major's blast radius extends to two production-bound repos (HealthBite and Healix) plus the dev Supabase project. A leaked service-role key or a missed input-validation step turns into a real incident. Treat security as a baseline, not a feature.

## Pre-Commit Checklist

Before ANY commit, verify:

- [ ] No hardcoded secrets — service-role keys, OpenAI keys, GitHub tokens, webhook secrets.
- [ ] All user inputs validated by a schema (see `coding-style.md`).
- [ ] SQL queries are parameterized via the Supabase client. **Never** concatenate user input into a SQL string.
- [ ] If the change adds a new endpoint: authentication is enforced. RLS is configured.
- [ ] Error messages returned to clients don't include stack traces, DB error text, or internal identifiers.
- [ ] If the change touches the Runner image: secrets are read from env vars, never baked into the image.

## Secret Management

- **Never hardcode secrets in source code, prompts, or test fixtures.** This includes commit messages, log lines, and error messages.
- **Use environment variables only.** In edge functions: `Deno.env.get("...")`. In the Runner: passed via `docker run -e`. In the UI: `NEXT_PUBLIC_*` for client-safe values, server-only for everything else.
- **Validate required secrets at startup.** If `SUPABASE_SERVICE_ROLE_KEY` is missing, the function should fail fast at boot with a clear error, not crash on first request.
- **Rotate any exposed secret immediately.** See `docs/failure-modes.md` § 14 for the rotation runbook.

## SQL Injection

Major uses the Supabase JS client (`@supabase/supabase-js`) and PostgREST exclusively for DB access. Use the typed builder (`.from(...).select(...).eq(...)`); never use `.rpc()` with string-concatenated SQL, never invoke `.sql\`...\`` template-literal queries with user input embedded.

```ts
// Wrong — user input concatenated into a SQL string
await client.rpc("get_items_by_status", { sql: `WHERE status = '${status}'` });

// Correct — parameterized via the typed builder
const { data, error } = await client
  .from("work_items")
  .select("*")
  .eq("status", status);
```

For raw SQL needed in migrations or stored procedures: parameterize via Postgres's `$1`, `$2` placeholders, never via string interpolation.

## Authentication & Authorization

Major's edge functions use the `_shared/auth.ts` helper. All user-facing endpoints validate the JWT and resolve the calling user before any business logic.

- RLS policies on `major.*` tables enforce two-dev access. Never bypass RLS in user-facing functions.
- Functions that legitimately need elevated access (e.g., `major-reaper`, `major-github-webhook`) use the service-role client and document why in a comment at the top of `index.ts`.
- The Runner uses the service-role client for `major-claim-item` and `major-finalize-run` because it acts on behalf of the Workflow Store, not on behalf of a user.

## Webhook Verification

`major-github-webhook` MUST verify the `X-Hub-Signature-256` header against `GITHUB_WEBHOOK_SECRET` before parsing the payload. An unsigned or mis-signed request is rejected with `401`. No exceptions.

## Logging Hygiene

- Logs go to Supabase function logs (edge functions) or container stdout (Runner). Both surfaces are visible to operators only, but treat them as semi-public.
- **Never log secrets** — even partial fragments. Use `redact()` helpers when in doubt.
- **Never log full payloads** that may contain user content. Log shape and identifiers (Item id, Run id) instead.

## Response Protocol

If a security issue surfaces during development:
1. **STOP** and assess severity. Don't keep coding around it.
2. Fix CRITICAL issues before continuing — leaked credential, RLS bypass, unverified webhook.
3. Rotate any exposed secrets per `docs/failure-modes.md` § 14.
4. Review surrounding code for similar issues.
5. File an issue with the title `Security: <short description>` so the post-incident review has a tracking record.
