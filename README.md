# Major

AFK agent orchestrator. Intakes engineering work via Triage Sessions, fans into vertical-slice Work Items, runs them through sandboxed agent execution, surfaces results for human review.

Drives **HealthBite** (`~/Projects/healthbite`) and **Healix** (`~/Projects/healix`). State lives in the existing Supabase dev project (`nuihvxluxdpdjgkvtdih`) under a new `major.*` schema.

## Components

- **Major** — DB (`db/`), edge functions (`functions/`), Next.js UI (`ui/`)
- **Runner Instance** — long-lived Docker container (`runner/`), heartbeat + lease
- **Tachikoma** — ephemeral Claude Code subprocess inside Runner; role per prompt (`runner/prompts/`)

## Authoritative reference

`SPEC.md` is the source of truth. Read it before changing anything.

## Repo layout

```
db/             SQL migrations + schema (foundry.* tables… we mean major.*)
functions/      Supabase edge functions (Deno) — Major's API surface + GitHub webhook receivers
ui/             Next.js app (Major UI)
runner/
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

Trunk-based, two devs (jointly review). `develop` is integration; `main` is releases. Major's Items merge to `develop`. Releases are explicit `develop → main` merges + EAS builds (HealthBite) or Healix deploys.

## Getting started

1. Apply schema to dev project: `supabase db push` (after `supabase link --project-ref nuihvxluxdpdjgkvtdih`)
2. Deploy edge functions: `supabase functions deploy major-<name>` (one per function in `functions/`)
3. Build UI: `cd ui && npm install && npm run dev`
4. Build runner image: `cd runner && docker build -t major-runner .`
5. Run a runner: `docker run -d --name runner-A major-runner`
6. Register GitHub webhook on `MioMarker/healthbite` and `MioMarker/healix` pointing at `major-github-webhook` URL

Deferred: monitoring UI, runner pool autoscaling, declarative config API.

## Provenance

Major's lifecycle model is inspired by RelyMD's Foundry (`~/Projects/platform/common/docs/foundry/`). See `docs/adr/001-major-derived-from-foundry.md` for the inheritance and the deliberate cuts.
