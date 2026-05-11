# 020. Test framework split: pgTAP for RPCs, Deno test for edge functions, Vitest for Shell

## Status

`Accepted`

Date: 2026-05-11

## Context

Major has three distinct runtime environments, each with different test requirements:

1. **Postgres RPCs** (`supabase/migrations/*.sql`) — PL/pgSQL functions executed in Postgres. Testing requires a live DB or a close emulation. Unit-testing SQL logic from JavaScript is awkward.
2. **Edge functions** (`supabase/functions/major-*/index.ts`) — TypeScript running in Deno's edge runtime. Deno has a built-in test runner (`deno test`).
3. **Shell daemon** (`shell/main.ts`, `shell/tachikoma.ts`) — TypeScript running in Node.js (compiled via `tsc`). Standard Node test tooling applies.

As of the 2026-05-09 audit (finding F-23), there are **no automated tests** on lifecycle-mutating code. Stream E of Plan 001 introduces a test suite from scratch. The decision here is which test framework(s) to use.

### Alternatives considered

1. **pgTAP + Deno test + Vitest, per runtime** (chosen) — each environment uses the natural tool for that runtime. A single `npm test` script aggregates all three.
2. **Jest everywhere** — runs via Node. Can test Shell code natively, but testing Deno edge functions requires transpilation and mocking the Deno globals. Testing SQL RPCs still requires a separate harness. Net: more glue code, less fidelity.
3. **Vitest everywhere** — same problem as Jest for Deno and SQL. Vitest is faster than Jest but doesn't solve the runtime mismatch.
4. **Deno test for edge functions + Deno test for Shell** — Shell code would need to be Deno-compatible or heavily mocked. The Shell compiles to Node; maintaining Deno compatibility is unnecessary coupling.

### Forces

- Deno edge functions already use Deno-specific globals (`Deno.serve`, `Deno.env`, JSR imports). Transpiling to Node for testing introduces a large mock surface.
- pgTAP is the standard for in-database SQL testing. It runs inside Postgres, so it tests the actual RPC behavior including transaction semantics, constraint violations, and RLS.
- The Shell is a Node.js TypeScript project. Vitest is the fastest modern test runner for that environment and has first-class TypeScript support.
- We want a single `npm test` command for CI. Each sub-runner outputs TAP or JSON; a simple aggregator script collects exit codes.

## Decision

**Use the natural test tool for each runtime:**

| Layer | Framework | Runner command |
|---|---|---|
| Postgres RPCs | pgTAP | `pg_prove -h ... tests/rpc/*.sql` |
| Edge functions | Deno test | `deno test supabase/functions/` |
| Shell (Node) | Vitest | `npm run test:shell` (in `shell/`) |

A root-level `npm test` script in `package.json` runs all three in sequence and exits non-zero if any fails. CI runs `npm test` on every PR to `dev`.

pgTAP tests live in `tests/rpc/`. Deno tests live adjacent to their function (`supabase/functions/major-*/index.test.ts` pattern already established). Vitest tests live in `shell/` adjacent to the code under test.

## Consequences

**Positive:**
- Each framework tests its target runtime faithfully — no mocking Deno globals in Node, no transpiling.
- pgTAP tests catch SQL bugs (constraint violations, concurrency) that JavaScript-level mocks cannot.
- `deno test` is zero-config for edge functions that already import from `jsr:`.

**Negative:**
- Three frameworks to learn and maintain instead of one.
- CI setup requires pgTAP installed on the runner (or a Supabase CLI local DB). Stream E must handle this.
- pgTAP tests need a running Postgres instance. The CI workflow must spin up `supabase start` (local) or connect to a disposable test schema on the dev project.

**Follow-on work:**
- Stream E: implement the pgTAP suite, Deno test suite, and Vitest suite.
- Add a `tests/rpc/` directory with a `Makefile` or shell script for running pgTAP.
- Add `npm test` aggregator to root `package.json`.
- Add `.github/workflows/test.yml` CI workflow that runs `npm test` on every PR targeting `dev`.
