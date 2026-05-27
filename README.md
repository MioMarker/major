# Major

AFK agent orchestrator. Intakes engineering work via Triage Sessions, fans into vertical-slice Briefs, dispatches them to sandboxed Shells for agent execution, surfaces results for human review.

**Status:** v1 — internal use only, two-dev development.

Drives **HealthBite** (`~/Projects/healthbite`) and **Healix** (`~/Projects/healix`). State — the **Cyberbrain** — lives in the existing Supabase dev project (`nuihvxluxdpdjgkvtdih`) under a `major.*` schema.

The component vocabulary (Brief, Shell, Tachikoma, Cyberbrain) follows ADR 004 (`docs/adr/004-ghost-in-the-shell-naming.md`).

## Components

- **Major** — orchestrator. Cyberbrain (`db/`), edge functions (`functions/`), Next.js UI (`ui/`)
- **Shell** — long-lived Docker container (`shell/`), heartbeat + lease; the cyborg body that hosts Tachikomas
- **Tachikoma** — ephemeral Claude Code subprocess inside a Shell; role per prompt (`shell/prompts/`)

## Authoritative reference

`SPEC.md` is the source of truth. Read it before changing anything.

## Repo layout

```
db/             SQL migrations + schema (Cyberbrain — major.* tables)
functions/      Supabase edge functions (Deno) — Major's API surface + GitHub webhook receivers
ui/             Next.js app (Major UI)
shell/
  prompts/      Tachikoma role prompts with version constants
docs/
  adr/          Architecture decision records
  CONTEXT.md    Domain glossary
  runbook.md    Operational guide
  failure-modes.md  Failure mode catalog
.claude/
  rules/        Path-glob agent rules for Claude Code working ON Major
AGENTS.md       Top-level agent instructions
CLAUDE.md       Symlink to AGENTS.md
SPEC.md         System Specification (the source of truth)
```

## Workflow

Trunk-based, two devs (jointly review). `dev` is integration; `main` is releases. Major's Briefs merge to `dev`. Releases are explicit `dev → main` merges + EAS builds (HealthBite) or Healix deploys.

## Getting started

1. Apply schema to dev project: `supabase db push` (after `supabase link --project-ref nuihvxluxdpdjgkvtdih`)
2. Deploy edge functions: `supabase functions deploy major-<name>` (one per function in `functions/`)
3. Build UI: `cd ui && npm install && npm run dev`
4. Build Shell image: `cd shell && docker build -t major-shell .`
5. Run a Shell: `docker run -d --name shell-A -e SHELL_ID=shell-A major-shell`
6. Register GitHub webhook on `MioMarker/healthbite` and `MioMarker/healix` pointing at `major-github-webhook` URL

Deferred: monitoring UI, Shell pool autoscaling, declarative config API.
