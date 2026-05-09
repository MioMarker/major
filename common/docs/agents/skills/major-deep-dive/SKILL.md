---
name: major-deep-dive
description: "Full sync into Major — instructs the agent to immediately Read AGENTS.md, SPEC.md, docs/CONTEXT.md, docs/runbook.md, docs/failure-modes.md, and every ADR into context (~1,200 lines total). Use when about to do substantial Major work and would rather pay the upfront context cost than fetch each doc on demand. For lightweight orientation only, use major-dive."
---

# Major Deep Dive

Full sync. Read every authoritative Major doc into context before doing anything else, so subsequent questions can be answered without further file reads.

## Read these now, in order

Use the Read tool on each absolute path. Don't skip any:

1. `/Users/pioneer/Projects/major/AGENTS.md` — operating rules + directory ownership.
2. `/Users/pioneer/Projects/major/SPEC.md` — primitives, lifecycle, schema, API. Authoritative.
3. `/Users/pioneer/Projects/major/docs/CONTEXT.md` — domain glossary; vocabulary tiebreaker.
4. `/Users/pioneer/Projects/major/docs/runbook.md` — setup, deploy, day-to-day.
5. `/Users/pioneer/Projects/major/docs/failure-modes.md` — what goes wrong, mapped to repairs.
6. Every file under `/Users/pioneer/Projects/major/docs/adr/` (including `README.md`) except `000-template.md`.

Total ~1,200 lines across 6+ files.

## After loading, confirm

Reply with a one-paragraph confirmation that includes:

- ADR titles loaded (numbered).
- Hard boundaries from `AGENTS.md` (numbered, one line each).
- A short statement of what task you're now ready to take on.

This is the checkpoint — if the user spots a gap (wrong ADR loaded, missing boundary), they correct before you act.

## Relationship to major-dive

`major-dive` is a 76-line map; it points to docs but does not load them. Use `major-dive` for quick "where do I look?" questions. Use this skill (`major-deep-dive`) when you're about to do real work — multi-file edits, architectural changes, protracted debugging — and want to avoid per-question doc-fetch overhead.

If you reach for a doc that wasn't on the read list above, that's a gap in this skill. Call it out and propose adding it.
