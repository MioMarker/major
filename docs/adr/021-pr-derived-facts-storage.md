# 021. PR Derived Facts storage: JSONB column on `major.briefs`

## Status

`Accepted`

Date: 2026-05-11

## Context

When `major-github-webhook` receives `pull_request` events for a Brief's branch, it captures facts about the PR's merge readiness: CI status, review approval counts, conflicts, and branch protection state. These facts drive UI badges (`needs-rebase`, `ci-pending`, `approved`) and gate the `major-confirm-qa` flow.

The 2026-05-09 audit (finding F-17) found that these facts are **not persisted** — the webhook handler parses the payload but discards the derived facts. The UI has no source of truth for CI or review state.

The question is where to store them.

### Alternatives considered

1. **JSONB column `pr_derived_facts` on `major.briefs`** (chosen) — a single column holds the current snapshot of PR facts. Simple to query; no join required for the Brief Detail page. Schema can evolve without migrations until the field set stabilizes.
2. **New `major.pull_requests` table** — a dedicated relational table with typed columns (`mergeable boolean`, `ci_status text`, `approvals_count integer`, etc.). Cleaner schema, queryable by field. Requires a migration and adds a join to every Brief query that needs these facts.
3. **Store in `major.events` payload only** — each webhook event payload already carries PR facts. Consumers would query the latest `pull_request.*` Event for a Brief and extract facts from the JSONB payload. No schema change needed, but querying is expensive and the "current snapshot" is scattered across events.

### Forces

- In v1 we don't know which PR fact fields will be queried relationally. Prematurely normalizing to a typed table risks over-specifying a schema we'll change.
- The Brief Detail page needs PR facts in the same query as the Brief row. A JSONB column on `major.briefs` satisfies this with zero extra round-trips.
- The JSONB field set is driven by GitHub's API response shape, which we don't control. Typing each field as a column makes migrations necessary every time GitHub adds a relevant field.
- `major-confirm-qa` needs to check `pr_derived_facts->>'pr_status' = 'merged'` before accepting QA confirmation (finding F-21). A JSONB column is simple for this check.

## Decision

**Add `pr_derived_facts JSONB NOT NULL DEFAULT '{}'` to `major.briefs`.**

The column stores a snapshot of the latest PR-derived facts for that Brief's branch. It is overwritten (not appended) on each `pull_request` webhook event. The initial shape:

```json
{
  "pr_number": 42,
  "pr_url": "https://github.com/...",
  "pr_status": "open",
  "mergeable": true,
  "ci_status_rollup": "pending",
  "approvals_count": 1,
  "requested_changes_count": 0,
  "branch_protection_state": "passing",
  "conflicts_known": false,
  "updated_at": "2026-05-11T00:00:00Z"
}
```

If no PR has been opened for a Brief, the column is `{}` (the default).

**Lift to a relational table** (`major.pull_requests`) in a future ADR if and when we need to: query Briefs by CI status, track PR history across re-runs, or enforce FK constraints on PR records. The JSONB column is explicitly a v1 shortcut.

## Consequences

**Positive:**
- Stream A migration is a single `ALTER TABLE` — minimal.
- Brief Detail query needs no join to display PR status badges.
- Field set can expand without additional migrations (just write new keys).
- `major-confirm-qa` merge-gate check is a simple `->>'pr_status' = 'merged'` condition.

**Negative:**
- No DB-level type enforcement on individual fields. A bug in the webhook parser can store malformed data silently.
- Cannot efficiently query "all Briefs with CI failing" without a GIN index on the JSONB column (add if needed; deferred).
- PR history is lost on each overwrite — only the latest snapshot is kept. Historical PR fact changes are visible only through `major.events` payloads.

**Follow-on work:**
- Stream A: add the `pr_derived_facts` migration and update `db/types.ts` with a `PrDerivedFacts` interface.
- Stream C: update `major-github-webhook` to write `pr_derived_facts` on `pull_request` events.
- Stream C: update `major-confirm-qa` to gate on `pr_derived_facts->>'pr_status' = 'merged'`.
- Revisit: if we need to query Briefs by CI status or approvals in the Briefs View, add a GIN index or promote to a relational table at that time.
