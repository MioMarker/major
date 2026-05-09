# 004. Ghost in the Shell naming convention

## Status

Accepted

Date: 2026-05-09

## Context

Major's vocabulary has been a mix of Foundry-derived terms (`Work Item`, `Runner Instance`, `Tachikoma`) and generic technical terms (`database`, `the runner`). The orchestrator is already named **Major** after Major Motoko Kusanagi from *Ghost in the Shell* (per ADR 001), but no other component name draws from that source. The metaphor is present but isolated.

A coherent naming theme that maps each component to a real GITS reference makes the system self-documenting. The references aren't decoration — they describe what each thing actually does.

## Decision

Adopt a Ghost in the Shell naming convention across all Major surfaces.

| Old name | New name | GITS reference | Why it fits |
|---|---|---|---|
| (unchanged) | **Major** | Motoko Kusanagi, Section 9 leader | Orchestrator. Receives work from above (the human, in the Aramaki/chief role) and dispatches it. |
| Work Item | **Brief** | Mission briefing | The crafted instruction + context the human hands to Major. The human's job is to prepare the brief carefully; Major's job is to execute it. |
| Runner Instance | **Shell** | Cyborg body that houses a "ghost" (consciousness) | Persistent container hosting ephemeral agent instances. The agent's "ghost" loads in, works, dissolves; the Shell persists for the next one. Doubles with the Unix-shell sense. |
| (unchanged) | **Tachikoma** | Semi-autonomous AI tanks in GITS — operate in parallel, learn independently, sync experiences | Implementation + first-round review of the resulting PR. Human is final authority on merges. |
| database / Workflow Store | **Cyberbrain** | Holds memory, identity, experience; Tachikoma canonically sync to a shared store | System of record. Stores Briefs, runs, events, actors, artifacts. |
| (unchanged) | **major-dive** | (skill) | Lightweight orientation; map without loading the territory. |
| (unchanged) | **major-deep-dive** | "Dive" = total system immersion in GITS | Full context-load; reads the key sources end-to-end. |

### Lifecycle in one sentence

> The human writes a Brief, Major dispatches it to a Shell, the Shell spins up a Tachikoma to implement and first-round review the work, the human makes the final call on the PR, and everything is logged to the Cyberbrain.

### What stays unchanged

- `Run`, `Triage Session`, `Event`, `Artifact`, `Verification Result` — primitives, not components; read fine alongside the new component names.
- Rules: `Run Start Transaction`, `Single Active Run Rule`, `Path-blocker rule`, `Triage Change Operation` — concept names, unchanged.
- Schema name `major.*` — Major IS the orchestrator; the schema belongs to it. Cyberbrain is the conceptual store; `major.*` is its physical realisation.

## Migration plan

Sequenced so the system stays buildable at each phase. Branch off `dev` (`refactor/gits-naming`); commit per phase; one PR or many at user's discretion.

### Phase 1 — Documentation (no behaviour change)

1. This ADR (004), status `Accepted` after user approves.
2. `docs/CONTEXT.md` glossary: replace **Work Item** / **Runner Instance** / **database** / **Workflow Store** entries with **Brief** / **Shell** / **Cyberbrain**. Old names go in `_Avoid_:` lines.
3. `SPEC.md` — rewrite primitive names, lifecycle prose, schema overview tables, slot table.
4. `docs/runbook.md`, `docs/failure-modes.md`, `AGENTS.md`, `README.md`.
5. `.claude/skills/major-dive` and `.claude/skills/major-deep-dive` — rewrite to new vocabulary.
6. `.claude/rules/*.md` — update any rule referencing old terms.

### Phase 2 — Code identifiers (compiles; may not run yet)

1. Rename directory `runner/` → `shell/`. Update all imports and the Dockerfile build context references in docs.
2. Rename TypeScript types in `db/types.ts`: `WorkItem` → `Brief`, `WorkItemContentRevision` → `BriefContentRevision`, `WorkItemRelationship` → `BriefRelationship`, `WorkItemArtifact` → `BriefArtifact`, `RunnerInstance` → `Shell`.
3. Rename API parameter and JSON field names: `runnerId` → `shellId`, `workItemId` / `itemId` → `briefId`, `workItem` → `brief`, etc.
4. Rename env vars: `RUNNER_ID` → `SHELL_ID`. Rename `runner/.env.example` → `shell/.env.example`.
5. Rename Docker image tag: `major-runner:latest` → `major-shell:latest`. Container naming convention: `runner-A` → `shell-A`.
6. UI routes/components: `/items` → `/briefs`, `WorkItemCard` → `BriefCard`, etc. (audit `ui/` for old terms).

### Phase 3 — Cyberbrain schema migration (coordinated)

New migration file `<timestamp>_gits_renames.sql`. Append-only per `AGENTS.md`. Statements (subject to a final code grep before writing):

- Tables: `work_items` → `briefs`, `work_item_content_revisions` → `brief_content_revisions`, `work_item_relationships` → `brief_relationships`, `work_item_artifacts` → `brief_artifacts`, `runner_instances` → `shells`.
- Columns: `runs.work_item_id` → `brief_id`, `runs.runner_id` → `shell_id`, `brief_content_revisions.work_item_id` → `brief_id`, plus any others surfaced by the grep.
- Functions: `major.claim_next_item` → `major.claim_next_brief`. Update RPC bodies to reference the new table/column names.
- Indexes: `idx_work_items_*` → `idx_briefs_*`, `idx_runner_instances_heartbeat` → `idx_shells_heartbeat`, `idx_revisions_work_item` → `idx_revisions_brief`. `idx_runs_single_active` keeps its name (concept unchanged).
- Foreign-key / check-constraint names embedding old terms: rename for hygiene.
- Update `db/types.ts` to match.

Apply via direct `psql -v ON_ERROR_STOP=1`, not `supabase db push` (per the migration-tracking issue documented in `runbook.md §1.2`).

### Phase 4 — Edge function endpoints (deploy-coordinated)

1. Rename function directories: `major-claim-item` → `major-claim-brief`, `major-list-items` → `major-list-briefs`, `major-get-item` → `major-get-brief`, `major-reject-item` → `major-reject-brief`.
2. Update `[functions.<name>]` blocks in `supabase/config.toml`.
3. Redeploy the renamed functions. Old URLs return 404 after redeploy.
4. Update the Shell (`shell/main.ts`) to call the new endpoints.

### Phase 5 — Live restart

1. Stop existing Shell containers (e.g. `docker rm -f runner-A`).
2. Sweep any orphan running Runs (per `failure-modes.md`).
3. Rebuild image as `major-shell:latest`.
4. Start new Shells with renamed env (`SHELL_ID=shell-A`, etc.).

## Consequences

### Good

- Naming is intentional and self-documenting. New contributors and AI agents can map a component name to its role using the GITS reference as a mnemonic.
- "Tachikoma loads into the Shell, does the work, dissolves; the Shell persists" is technically accurate — Major's Tachikomas literally load into a Shell container and exit, exactly what GITS Tachikomas do with replacement bodies.
- Disambiguates Major from the GitHub Actions / Sandcastle / Foundry senses of "runner" — useful since Major drives repos that use both.
- Coherent vocabulary makes future docs, skills, and ADRs tighter.

### Trade-offs

- One-time migration cost across docs + code + schema + redeploys (laid out above).
- "Shell" overloads the Unix-shell sense. Convention: capitalized **Shell** is a Major Shell; lowercase `shell` (e.g. `bash`, `zsh`, "shell out") refers to the Unix concept. `bash` and `sh` references in `Dockerfile` and scripts stay unchanged.
- Existing branch-name conventions (`agent/issue-N` in Sandcastle, `major/work-item-N` in Major) — the Major branch convention becomes `major/brief-N`. Old branches stay for history.

### Reversibility

Reversible via another equivalent rename. ADR 004 supersedes ADR 001 wherever component names conflict.

## Resolved — schema migration mechanic

Decision: **(A) ALTER TABLE / ALTER FUNCTION in a new migration.** Append-only-respecting per `AGENTS.md`; preserves rows in `runs`, `events`, `verification_results`. Single new file `<ts>_gits_renames.sql` carries all DDL.

(B) "edit existing migrations + DROP SCHEMA + reapply" was rejected because it violates the append-only migration rule and the audit-trail benefit outweighs the migration-sprawl downside.

## References

- User's GITS naming rationale, this conversation 2026-05-09.
- ADR 001 — Major derived from Foundry (vocabulary baseline this partially supersedes).
- `docs/CONTEXT.md` — glossary tiebreaker (will be updated in Phase 1).
- `docs/runbook.md §1.2` — schema-apply procedure given the shared `_supabase_migrations` issue.
