# Major DB

Major's authoritative store. Schema lives under `major.*` in the existing
Supabase **dev** project (`nuihvxluxdpdjgkvtdih.supabase.co`). The full DDL
is in `0001_initial_schema.sql`; SPEC.md's "Schema overview" enumerates the
tables and their roles.

## Files

| File | Purpose |
|---|---|
| `0001_initial_schema.sql` | Initial migration. Creates the `major` schema and all 15 tables, plus seeds `artifact_type_contracts` and `path_blocker_config`. |
| `types.ts` | Hand-maintained TypeScript types for every table. Imported by `functions/`, `runner/`, and `ui/`. |
| `types.smoke.ts` | Compile-only smoke test exercised by `tsc --noEmit --strict`. |
| `tsconfig.json` | Local strict typecheck config for the smoke test. |

## Hosting

| Project ref | Role |
|---|---|
| `nuihvxluxdpdjgkvtdih` | Major's authoritative DB (lives alongside HealthBite's existing dev project). All tables are namespaced under the `major` schema so they don't collide with HealthBite's `public.*` tables. |

There is no separate "production" Supabase project for Major in v1 — Jonathan
and Paul are the only two users, all RLS-gated, and both work against the dev
project. Add a prod project only when Major leaves internal use.

## Applying migrations

Migrations are idempotent SQL files that run top-to-bottom in number order.
Apply via the Supabase CLI:

```bash
# From the major repo root
npx -y supabase link --project-ref nuihvxluxdpdjgkvtdih    # one-time
npx -y supabase db push --dry-run                          # preview
SUPABASE_DB_PASSWORD='<postgres-admin-pw>' npx -y supabase db push
```

The password is the project's Postgres admin password (Supabase Dashboard →
Project Settings → Database). Never hardcode it; pass via env each time.

If `db push` complains about remote-only migration entries left over from
another project, repair the history:

```bash
npx -y supabase migration repair --status reverted <version>
```

## Convention

- **One SQL file per migration**, numbered monotonically: `0001_*.sql`,
  `0002_*.sql`, ... The number is the source of order, not the timestamp.
  This keeps migrations short, reviewable, and rebase-friendly.
- **Append-only.** Once a migration is on `develop`, never edit it. Mistakes
  in shipped migrations are corrected by a follow-up migration, not by
  rewriting history. (`db push` keys off file content; editing in place
  desynchronizes local from remote.)
- **Descriptive name in the filename:** `0002_add_run_budget_columns.sql`,
  `0003_backfill_queue_rank.sql`. Skim-readable in `git log`.
- **Schema-qualify everything:** every CREATE/ALTER targets `major.<table>`.
  Don't drop into `public`.
- **Idempotent where cheap:** `create schema if not exists`, `drop ... if
  exists` for fixtures. Don't `if exists` real tables — that hides drift.

## When you need an ADR

A migration counts as **trivially additive** (no ADR required) if it only:

- Adds a new table under `major.*`
- Adds a nullable column to an existing table
- Adds an index, trigger, or check constraint that does not change existing
  semantics
- Backfills data without changing column meaning
- Adds a value to a CHECK-enforced enum that doesn't displace existing values

Anything else needs an ADR in `docs/adr/` first:

- Renaming or dropping a column
- Changing a column's type or NOT NULL status on existing data
- Removing or narrowing a value from a CHECK enum
- Restructuring a relationship (e.g., turning a 1:1 into a join table)
- Changing a primary key or unique constraint
- Splitting or merging tables
- Anything that requires coordinated deploys with `functions/`, `runner/`, or
  `ui/`

The ADR is a one-page note: what changes, why, what the migration plan looks
like, and what code must update in lockstep. Per AGENTS.md "When you encounter
ambiguity": decision-class changes ship via an ADR, never via implementation.

## Types

`types.ts` is hand-maintained from the SQL. There is no codegen step in v1.
When the schema changes:

1. Write the migration SQL.
2. Update `types.ts` with the new/changed columns and any new enum literals.
3. Extend `types.smoke.ts` if you added a new table or discriminated payload.
4. Run `npx -y tsc --noEmit --strict --project tsconfig.json` from this
   directory.

The smoke test is a compile-only artifact — it exercises every exported type
in a no-op assertion so a forgotten field or mistyped union surfaces during
typecheck rather than at runtime.

## Single Active Run Rule

The partial unique index on `runs(work_item_id) where outcome='running'` is
the DB invariant that makes the Run Start Transaction safe. AGENTS.md hard
rule #4: never bypass it. If you need a parallel-run primitive, that's a new
schema design and a new ADR.
