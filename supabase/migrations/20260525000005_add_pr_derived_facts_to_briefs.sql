-- 20260525000005_add_pr_derived_facts_to_briefs.sql
-- Implements docs/adr/021-pr-derived-facts-storage.md (the "Stream A" follow-on).
--
-- INCIDENT (2026-05-25): merged Brief PRs (69/70/73/75 on MioMarker/healthbite)
-- did NOT transition to `done`. Root cause: ADR 021's write path shipped (Stream C
-- updated major-github-webhook to write `pr_derived_facts` on `pull_request` events)
-- but the column it writes was never created — ADR 021's Stream A migration was
-- never authored/merged. The webhook's `UPDATE major.briefs SET pr_status, pr_url,
-- pr_derived_facts ...` therefore fails at runtime with
--   42703  column briefs.pr_derived_facts does not exist
-- which rolls back the whole UPDATE: `pr_status` stays at its default ('absent'),
-- `pr_url` stays null, and the merged→done transition never lands. The `pr-closed`
-- Event still inserts (separate statement, different table), which is why the
-- webhook delivered 200 OK while the Brief stayed `ready-for-review`.
--
-- Verified live (2026-05-25): `select pr_derived_facts from major.briefs` returns
-- 42703; briefs 69/70/73/75 are `ready-for-review` with `pr_status='absent'`,
-- `pr_url=null`, despite their PRs being merged on GitHub.
--
-- ADR 021 §Decision: "Add `pr_derived_facts JSONB NOT NULL DEFAULT '{}'` to
-- major.briefs." The column holds the latest PR-fact snapshot (overwritten, not
-- appended) per `pull_request` webhook event. Existing rows backfill to '{}' via
-- the default, so no query semantics change for Briefs without a PR.
--
-- After this is applied to the live dev project, redeliver the affected
-- `pull_request.closed` webhook deliveries so the webhook re-runs and performs the
-- now-unblocked terminal transition (human-attributed to the merger, per ADR 011).
--
-- Trivially additive per .claude/rules/db/migrations.md (new column, default
-- backfills existing rows, no behavior change to existing queries) and explicitly
-- decided by ADR 021 — no new ADR required.

set search_path = major, public;

begin;

alter table major.briefs
  add column if not exists pr_derived_facts jsonb not null default '{}'::jsonb;

commit;
