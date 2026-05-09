---
name: major-dive
description: "Lightweight orientation map for Major — the AFK orchestrator at ~/Projects/major. ~76 lines: primitives, hard boundaries, file layout, and pointers to deeper docs. Use as the front door before any Major work; the agent reads referenced docs (SPEC, runbook, ADRs, failure-modes) lazily as questions arise. For a one-shot heavyweight load of all Major docs at once, use major-deep-dive instead."
---

# Major Dive

Front door for Major work — a ~76-line orientation map. Keep light: orient, then load only the docs the task needs. For one-shot full sync of all Major docs (~1,200 lines), use `major-deep-dive` instead.

## What Major is

- AFK agent orchestrator inspired by RelyMD's Foundry. Code at `~/Projects/major`.
- State — the **Cyberbrain** — lives in `major.*` schema on the shared dev Supabase project (`nuihvxluxdpdjgkvtdih.supabase.co`). One environment in v1; no separate Major prod.
- Drives **HealthBite** (`~/Projects/healthbite`) and **Healix** (`~/Projects/healix`); opens PRs into their `dev` branches.
- Component vocabulary (Brief / Shell / Tachikoma / Cyberbrain) is fixed by `docs/adr/004-ghost-in-the-shell-naming.md`.
- This skill is for AI assistants and humans working *on* Major's code. Tachikomas (Major's own runtime agents) load prompts from `shell/prompts/<role>.md`; they don't read this skill.

## Minimum orientation

Read these first when entering a Major task:

- `~/Projects/major/AGENTS.md` — operating rules; `CLAUDE.md` symlinks to it.
- `~/Projects/major/SPEC.md` — primitives, lifecycle, schema, API surface. Authoritative.
- `~/Projects/major/docs/CONTEXT.md` — vocabulary tiebreaker.
- `~/Projects/major/docs/runbook.md` — setup, deploy, day-to-day commands.
- `~/Projects/major/docs/failure-modes.md` — what goes wrong, mapped to repairs.
- `~/Projects/major/docs/adr/` — irreversible decisions; respect, don't re-litigate.

Fast context: top of `AGENTS.md`, then search `SPEC.md` for the matching section (`Run Start Transaction`, `Path-blocker rule`, `Tachikoma`, `Triage Change Set`, `done`, `wontfix`, `Verification Result`).

## Hard boundaries

1. **The Cyberbrain is authoritative.** Don't read lifecycle state from GitHub, files, or env. The `major.*` schema is truth.
2. **Content vs Metadata.** Lifecycle code reads structured columns (`status`, `expected_paths`, `queue_rank`). It does not parse Brief Content (Markdown PRDs).
3. **Propose / apply separation.** Only Triage Change Operations and Run Finalization Transactions mutate Briefs. Don't add side-effect writes from chat handlers, webhooks, or background jobs.
4. **Single Active Run Rule.** Never bypass `idx_runs_single_active`. Two simultaneous Runs on one Brief is a bug.
5. **Path-blocker rule is non-optional.** Every Triage Change Set apply path runs it. No skip flag.
6. **Idempotency keys are mandatory** on every retryable write (Events, Verification Results, Run Finalization, Change Operation apply).
7. **Prompt versioning.** Bump `*_PROMPT_VERSION` in `shell/prompts/versions.ts` to `<role>@YYYY-MM-DD` whenever a Tachikoma prompt changes.
8. **PRs target `dev`.** `main` is release; `dev → main` is an explicit human act outside the Brief lifecycle.
9. **No secrets in code or prompts.** Service-role keys, OpenAI keys, GitHub tokens — env vars only.
10. **Acceptance is human-only.** Agents never transition Briefs to `done`; the `done` Event must be attributed to a human Actor.

## Where things live

| Area | Path | Notes |
|---|---|---|
| Cyberbrain schema | `supabase/migrations/` | Append-only, `YYYYMMDDHHMMSS_<name>.sql` |
| TS types | `db/types.ts` | Hand-maintained mirror of schema; no codegen in v1 |
| API | `supabase/functions/major-*/` | One dir per function; helpers in `_shared/` |
| Gateway | `supabase/config.toml` | `verify_jwt = false` for all major-* (Shell uses `sb_secret_*`, not a JWT) |
| UI | `ui/` | Next.js App Router; Supabase auth; deployed to Vercel by manual CLI |
| Shell image | `shell/` | `Dockerfile`, `main.ts`, `tachikoma.ts`, `prompts/` |
| Tachikoma prompts | `shell/prompts/{implementer,reviewer,planner,triage,repair}.md` | Each phase = fresh `claude` subprocess |
| Rules | `.claude/rules/` | Path-glob auto-load when editing matching files |
| Docs / ADRs | `docs/` | `CONTEXT.md`, `runbook.md`, `failure-modes.md`, `adr/` |

## Route the work

- User wants to **operate** Major (deploy a function, fire a Shell, unstick a Run, sweep orphans) → `docs/runbook.md` + `docs/failure-modes.md`.
- User wants to **build on** Major (new edge function, prompt role, schema change, UI surface) → `SPEC.md` for the primitive; `AGENTS.md` "Directory ownership" for where it lands.
- User wants to **trigger work through** Major (file an issue, prepare a Brief, draft Briefs) → Triage Sessions surface in the UI, or call `major-create-triage-session` directly.
- User wants to **reason about** the lifecycle (status transitions, classifications, artifact contracts) → `SPEC.md` lifecycle section + `docs/CONTEXT.md` glossary.
- User asks for implementation already inside a known primitive → use normal coding skills (`tdd`, `commit`) and respect the boundaries above.

## Operational caveats (learned the hard way)

- **Migrations.** The Supabase CLI's `_supabase_migrations` table on the dev project is shared with HealthBite — `supabase db push` will list HealthBite's migrations as remote-only and refuse. Apply Major's migrations via direct `psql -v ON_ERROR_STOP=1` (see `runbook.md §1.2`), not `supabase db push`.
- **Auth.** The Shell sends the new-format service-role key (`sb_secret_*`). The Supabase platform JWT pre-check rejects it with `UNAUTHORIZED_INVALID_JWT_FORMAT`, so every major-* function sets `verify_jwt = false`. Auth is enforced inside `_shared/auth.ts` (service-role bypass requires `X-Major-Shell-Id` header; user JWTs go through `auth.getUser`).
- **PostgREST schema exposure.** `major` must be in PostgREST's exposed schemas list (Supabase Dashboard → Project Settings → API), and `service_role` needs USAGE/SELECT/INSERT/UPDATE/DELETE on the schema (`20260509000003_schema_grants.sql`). Both are required; either missing yields `PGRST106` or `PG 42501`.
- **Shell ≠ Tachikoma.** Shell = the long-lived Docker container with heartbeat + lease (the cyborg body). Tachikoma = ephemeral `claude` subprocess inside, one per phase per Run (the ghost that loads in, works, dissolves). Don't conflate when reasoning about lifecycle or telemetry.
- **Capitalized Shell vs Unix shell.** Capitalized **Shell** = a Major Shell. Lowercase `shell` (`bash`, `zsh`, "shell out", "shell script") = the Unix concept. Don't rename the Unix sense in Dockerfiles or scripts.
- **Dockerfile prompt copy.** `tsc` compiles `prompts/versions.ts` into `dist/prompts/`, which already exists; copying the markdown must be `cp prompts/*.md dist/prompts/`, never `cp -r prompts dist/prompts` (creates `dist/prompts/prompts/`).
- **Orphan running Runs.** If a container is `docker rm -f`'d mid-claim, a Run row stays `outcome='running'` and the partial unique index blocks new claims. The reaper sweeps after lease expiry; for immediate recovery, cancel via SQL.

## Provenance

Major's lifecycle model is derived from RelyMD's Foundry (`~/Projects/platform/common/docs/foundry/`). Naming, primitives, and state machine are deliberately close to Foundry's. See `docs/adr/001-major-derived-from-foundry.md` for the inheritance and deliberate cuts. Component-name vocabulary (Brief, Shell, Cyberbrain) layered on top per `docs/adr/004-ghost-in-the-shell-naming.md`.
