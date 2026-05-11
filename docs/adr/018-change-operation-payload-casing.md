# 018. Triage Change Operation payload casing: snake_case in JSONB, camelCase on TS interfaces

## Status

`Accepted`

Date: 2026-05-11

## Context

`major.triage_change_operations.payload` is a JSONB column. Two consumers read it:

1. The `apply_change_set` SQL RPC (`supabase/migrations/`) — reads payload keys via `v_payload->>'field_name'`.
2. TypeScript code in `supabase/functions/major-apply-change-set/index.ts` and `db/types.ts` — reads the same payload via JS object destructuring.

The 2026-05-09 e2e audit (finding F-03) found that `db/types.ts` defines `TriageChangeOperationPayload` with camelCase keys (`expectedPaths`, `contentMd`, `briefId`), but the SQL RPC reads snake_case keys (`expected_paths`, `content_md`, `brief_id`). The result: every Change Operation produced by the Triage Tachikoma has its fields silently null'd when the RPC reads them, because the keys never match.

This blocks all Change Set apply operations — a P0 finding.

### Alternatives considered

1. **snake_case everywhere** — JSONB keys and TS interfaces both snake_case. No conversion needed; SQL and TypeScript agree.
2. **camelCase everywhere** — JSONB keys and TS interfaces both camelCase. SQL reads `v_payload->>'briefId'`. Feels natural in TypeScript, awkward in SQL.
3. **snake_case in JSONB, camelCase in TS with conversion at the edge** (chosen) — JSONB keys are snake_case (canonical for Postgres); TS interfaces are camelCase, converted once at the boundary when serializing/deserializing the payload.

### Forces

- Postgres convention is snake_case for column and JSONB field names. SQL RPCs reading mixed-case JSONB is an ongoing maintenance hazard.
- The Triage Tachikoma writes the payload JSON. Prompts currently describe fields in camelCase (`expectedPaths`). The prompt needs updating regardless — choosing snake_case in the payload means the prompt update is the only place the casing is defined.
- TypeScript idiomatic style is camelCase. Dual casing with a single conversion point is the standard pattern (matches what Supabase JS client does for column names on query responses).

## Decision

**JSONB payload keys are snake_case.** This is the canonical representation stored in `major.triage_change_operations.payload`.

**TypeScript interfaces are camelCase.** `TriageChangeOperationPayload` in `db/types.ts` uses camelCase field names. Code that serializes a payload to JSONB converts at the call site (one function, `toPayload(op: TriageChangeOperationPayload): Record<string, unknown>`). Code that deserializes from JSONB converts at the read site.

The Triage Tachikoma prompt (`shell/prompts/triage.md`) is updated to describe payload fields in snake_case, since that is what the Tachikoma actually writes.

## Consequences

**Positive:**
- SQL RPCs (`apply_change_set`, `claim_next_brief`, `reaper_sweep`) read keys that match what's stored — no silent null fields.
- A single conversion layer isolates the impedance mismatch. Future changes to field names have one update point per direction.

**Negative:**
- Existing production Change Operations stored with camelCase keys in JSONB are now unreadable by the fixed RPC. Any in-flight or stored `proposed` operations need a one-time migration or manual replay. (In practice: wipe and re-triage any open sessions.)
- The Tachikoma prompt must be updated and versioned simultaneously with the RPC fix.

**Follow-on work:**
- Stream B (RPC correctness): audit every `v_payload->>'…'` site in `apply_change_set`, `finalize_run`, `claim_next_brief` and confirm snake_case.
- Stream C: update `major-apply-change-set` edge function serialization helper.
- Bump `TRIAGE_PROMPT_VERSION` when updating the Tachikoma prompt.
- If any open `proposed` Change Operations exist at time of deploy, run: `UPDATE major.triage_change_operations SET status = 'rejected' WHERE status = 'proposed';` to clear stale camelCase payloads.
