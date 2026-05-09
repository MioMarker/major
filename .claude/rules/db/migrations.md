# DB Migrations

Major's schema lives in `db/`. Migrations are append-only and monotonically numbered. Production-critical state lives in `major.*` on the dev Supabase project (`nuihvxluxdpdjgkvtdih`); a broken migration bricks the orchestrator.

## Append-Only

- **Never edit a previously-merged migration.** Once a migration has been applied to the dev project (or merged to `dev`), it is immutable.
- To change a previous migration's effect, write a new migration that supersedes it. Drops, alters, and column renames all go in new files.
- The only acceptable in-place edit to an existing migration file is fixing a typo before the file has ever been applied. After that: write a new file.

## Numbering

- Files in `db/` are named `NNNN_short-description.sql` with a four-digit zero-padded number, monotonically increasing from `0001`.
- The next number is always one greater than the highest existing number. Don't skip; don't reuse.
- The description is short, kebab-case. Good: `0002_add-runner-pool-state.sql`. Bad: `0002_changes.sql`.

## `supabase db push` Workflow

```bash
# Always dry-run first; review the SQL the CLI is about to execute
npx -y supabase db push --dry-run

# Apply for real
SUPABASE_DB_PASSWORD='<dev-postgres-admin-password>' \
  npx -y supabase db push
```

The password is the dev project's Postgres admin password (Jonathan has it). Never inline it in scripts or commit it.

If the CLI reports remote-only migrations (e.g., something the dev project has that the local `db/` doesn't), do **not** delete remote rows. Run `npx -y supabase migration repair --status reverted <version>` to clear stale entries from the migration history table; then re-push.

## ADRs Required for Non-Trivial Schema Changes

A migration is "trivially additive" (no ADR required) when it:

- Adds a new table whose presence has no behavioral effect on existing code paths.
- Adds a new nullable column with a default that doesn't change query semantics.
- Adds an index for read performance.
- Inserts seed data that is idempotent and isolated.

Any other schema change requires an ADR (`docs/adr/NNN-<title>.md`) before the migration is written. Examples:

- Adding or removing a column that lifecycle code reads.
- Changing the type of a column.
- Adding a NOT NULL constraint to an existing column.
- Adding a unique or partial unique index that affects insert semantics.
- Changing RLS policies.
- Modifying an artifact_type_contracts row's claim/produce/review/verify rules.
- Adding a new entry to the path-blocker config (this is data, but the *decision* of what to protect is architectural).

Write the ADR first; reference it in the migration file's leading comment:

```sql
-- 0007_add-priority-class-column.sql
-- Implements docs/adr/006-priority-class-routing.md
-- This migration adds priority_class to work_items and updates Runner Scheduling.

ALTER TABLE major.work_items
  ADD COLUMN priority_class TEXT NOT NULL DEFAULT 'standard';
```

## Defensive Patterns

- Wrap multi-statement migrations in `BEGIN; ... COMMIT;` — Supabase applies them in a transaction by default, but explicit is better than implicit.
- Use `IF NOT EXISTS` on `CREATE TABLE`, `CREATE INDEX`, `CREATE EXTENSION`. Idempotency is forgiving.
- Use `ON CONFLICT DO NOTHING` for seed `INSERT`s.
- Comment non-obvious choices inline. The migration is the audit trail; future contributors read it.

## Never

- Never run `supabase db push --include-all` without a dry-run.
- Never edit migrations applied to a real project.
- Never commit `SUPABASE_DB_PASSWORD` or any service-role key.
- Never bypass an ADR by hiding a behavior change inside an "additive" migration.
