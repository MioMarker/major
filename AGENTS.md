# Major — Agent Operating Instructions

Top-level instructions for Claude Code (and any other AI agent) working ON Major. For Major's own runtime agents (Tachikomas), see `runner/prompts/`.

## Read before acting

- `SPEC.md` — System Specification. Authoritative for primitives, lifecycle, schema, API surface.
- `docs/CONTEXT.md` — Domain glossary; tiebreaker when terms collide.
- `docs/adr/` — Decisions you must respect. Don't re-litigate without a new ADR.
- `.claude/rules/` — Path-glob rules auto-loaded by your runtime when you edit related paths.

## Hard rules

1. **The DB is authoritative.** Don't introduce shortcuts that read state from GitHub, files, or environment to make lifecycle decisions. The `major.*` schema is the truth.
2. **Content vs Metadata.** Lifecycle code reads structured columns (`status`, `expected_paths`, `queue_rank`). It does not parse Work Item Content (Markdown PRDs). Don't violate this — Content can say anything; it has no authority.
3. **Propose / apply separation.** Don't write code paths that mutate Work Items as a side effect of chat or background agent reasoning. State changes happen only via Triage Change Operations or Run Finalization Transactions.
4. **Single Active Run Rule.** Never bypass the partial unique index on `runs(work_item_id) where outcome='running'`. Two concurrent Runs on the same Item is a bug.
5. **Path-blocker is not optional.** Any code path that applies a Triage Change Set must run the path-blocker rule. Don't add a "skip" flag.
6. **Idempotency keys are non-negotiable.** Every retryable / replayable write (Events, Verification Results, Run Finalization, Change Operation apply) must include an idempotency key derived per `SPEC.md`.
7. **Prompt versioning.** When changing any Tachikoma prompt, bump its `*_PROMPT_VERSION` constant in `runner/prompts/versions.ts` to today's date in `<role>@YYYY-MM-DD` format. Same convention as HealthBite's `chat-with-ai`.
8. **PRs target `develop`, never `main`.** Major drives Items to merge to `develop`. Releases (`develop → main`) are explicit human acts outside the Item lifecycle.
9. **No secrets in code or prompts.** Service-role keys, `OPENAI_API_KEY`, GitHub tokens — env vars only.

## Directory ownership

| Path | Owner | Notes |
|---|---|---|
| `db/` | DB schema + types | Migrations are append-only; one SQL file per migration, monotonically numbered |
| `functions/` | Major's API | Each function its own dir under `functions/major-<name>/` with `index.ts` + `deno.json` |
| `functions/_shared/` | Shared API helpers | CORS, auth, response, db helpers |
| `ui/` | Next.js app | App Router; auth via Supabase |
| `runner/` | Runner Instance image + Tachikoma | `Dockerfile`, `main.ts`, `tachikoma.ts`, `prompts/` |
| `docs/` | Documentation, ADRs, runbook, failure modes | |
| `.claude/rules/` | Path-glob agent rules | Loaded by Claude Code when editing matching paths |

## Workflow

- Trunk-based; branch off `develop`, PR back to `develop`. `main` is release.
- Two devs jointly review (`@Pioneer18` + `@kuvekep14`). Author cannot self-approve.
- Linear history (squash or rebase merge); no merge commits to `develop`.
- `develop` and `main` both have rulesets: required PR, required code-owner review, no force-push.
- Agent-assisted commits get the `Co-Authored-By: Claude ...` footer.
- Issue → Triage Session → Items → PR. Auto-triage queue path-blocker rule is the only auto-apply path.

## When you encounter ambiguity

1. Reach for `SPEC.md`.
2. If `SPEC.md` is silent, check `docs/CONTEXT.md` and `docs/adr/`.
3. If the question is decision-class (alters architecture), draft an ADR and stop. Don't ship a decision via implementation.
4. If the question is implementation-class (clear given the spec), proceed.

## Common mistakes to avoid

- **Adding state to Items via comments / labels / external systems.** Lifecycle state lives in `major.work_items.status`. Don't shadow it with GitHub labels or PR titles.
- **Treating GitHub Issues as the Item store.** GitHub Issues are not Items. They can be a *trigger* (a webhook can create a Triage Session), but the Items themselves live in `major.work_items`.
- **Editing Work Item Content directly without creating a Content Revision.** Content is versioned. New text = new revision. Runs reference specific revisions.
- **Treating the eval gate as required for `verified`.** It is advisory. Sandbox-run `tsc --noEmit` + tests are required; eval gate is decoration.
- **Letting agents transition Items to `done`.** Acceptance is human-only in v1. The `done` Event must be attributed to a human Actor.

## Provenance

Major's lifecycle model is derived from RelyMD's Foundry (`~/Projects/platform/common/docs/foundry/`). The naming, primitives, and state machine are deliberately close to Foundry's; see `docs/adr/001-major-derived-from-foundry.md` for the inheritance and deliberate cuts.
