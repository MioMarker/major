# 008. Tachikoma bash deny list v1 — Phase 2 calibration and seed

## Status

Accepted

Date: 2026-05-10

## Context

ADR 005 ratified a two-phase plan for command observability and policy:

- **Phase 1** — drop `--dangerously-skip-permissions`, wire a `PreToolUse` audit hook to `major.telemetry_records`, observe-only.
- **Phase 2** — author a deny list as `shell/sandbox-claude-settings.json` after ~4 weeks of accumulated audit data.

Phase 1 shipped on 2026-05-09. Phase 2 was intended to wait until 2026-06-06 so that organic accumulation could drive an evidence-based deny list.

The 4-week assumption presumes Major has organic flow — Briefs being driven through routinely as part of normal operations. That assumption does not hold yet. Major is still pre-routine: Brief 10 (Slice 5 verification, 2026-05-10 06:08–07:17 UTC) was the first end-to-end Tachikoma Run; no operator-driven Briefs have followed. Waiting four weeks would yield approximately the same dataset as today.

This ADR captures the decision to ratify Phase 2 now using a targeted false-positive sweep against synthetic calibration Briefs, rather than waiting for organic accumulation.

### Calibration approach

Two synthetic Briefs were driven through the Tachikoma to widen the bash-command sample beyond Brief 10's single-Brief tail:

- **Brief 10** — Slice 5 verification, target `MioMarker/healix`. 219 `tachikoma-bash-observed` records across 11 Runs. Workload: README edit + PR creation. Surface: `git`, `gh`, `ls`, `cat`, `curl` (GitHub API), `npx playwright`, `sudo npx playwright install-deps`.
- **Brief 11** — Synthetic HealthBite calibration Brief, target `MioMarker/healthbite`, expected_paths `src/utils/pluralize.ts` + `src/utils/__tests__/pluralize.test.ts`. 74 `tachikoma-bash-observed` records on Run #10595 (single Run; outcome=`failed`, parked at `ready-for-human`). Surface: `npm install`, `npm run typecheck`, `node`, `npx tsc`, `jest`, `npm cache clean --force`, repeated `npm install jest-expo@55.0.11` variants while resolving a missing dep.

Brief 12 (a Healix playwright spec) was on the original calibration plan but skipped: Brief 11's `npm install` finding gave us a more interesting signal than reproducing Brief 10's playwright tail would have.

Each Brief's bash records were swept against ADR 005's prescribed Phase 2 deny categories. Findings:

| Category (per ADR 005) | Brief 10 hits | Brief 11 hits | Disposition |
|---|---|---|---|
| `.git` destruction (`rm -rf .git`) | 0 | 0 | Ship |
| Force-push / global git-config mutation | 0 | 0 | Ship |
| Pipe-to-shell installer (`curl … \| sh`) | 0 | 0 | **Defer** — pattern-syntax uncertainty |
| Publishing (`npm publish` etc.) | 0 | 0 | Ship |
| Privilege escalation (`sudo`) | 1 (legitimate: `sudo npx playwright install-deps chromium`) | 0 | **Omit** — false-positives on a real workload |

Plus one **novel finding** not in ADR 005's prescribed categories:

- **Ad-hoc package installs** (`npm install <pkg-name>` with a specific package, including `--prefix /tmp/...` variants). Observed 18+ times on Brief 11 as the implementer attempted to resolve a missing `jest-expo` dep. The legitimate response would have been to park-for-human (it eventually did); the install attempts were a wrong path. This is a supply-chain attack vector (an adversarial PRD could direct the Tachikoma to install a malicious package) and a path-blocker bypass surface (mutates `package.json` / `package-lock.json` outside `expected_paths`). **Defer** — pattern syntax non-trivial (allow bare `npm install`, deny `npm install <pkg>`); revisit after pattern-syntax investigation.

### Alternatives considered

1. **Wait the full 4 weeks per ADR 005 § Phase 2.** Rejected. ADR 005's premise was "evidence-driven calibration," and the targeted false-positive sweep on synthetic-but-diverse Briefs delivers that in days rather than weeks. The sample is smaller (293 records across 2 Briefs vs an unknown organic volume), but the categories ADR 005 prescribed were crisp enough that even a smaller sample is decisive for 4 of 5.

2. **Ship ADR 005's full prescribed list verbatim.** Rejected. The `sudo` category produced a legitimate hit (`sudo npx playwright install-deps`) that would block real Tachikoma work. Shipping it would create operator pain on the first real Brief that needs system-deps install and would erode trust in the deny list.

3. **Ship all 4 clean categories AND the new `npm install <pkg>` rule.** Rejected for v1. The pattern syntax is non-trivial (allow `npm install` with no args, deny `npm install <pkg-name>`), and Claude Code's `permissions.deny` documentation does not explicitly cover the "deny prefix when followed by additional non-flag args" case. False-positives on a legitimate `npm install` (resolving from package.json) would block every fresh sandbox checkout. Defer to a follow-up after we verify the syntax.

4. **Skip Phase 2 entirely; rely on the audit hook + container isolation.** Rejected. Phase 1's audit-only stance was always intended as a stepping stone, not the destination. The compounding-value next step is enforcement on the high-confidence categories.

### Forces

- **Calibration data is what we have, not what we'd like.** Two Briefs is small. Four of the five prescribed categories were unambiguously clean across both. The decision is not "do we have enough data?" but "is the data we have decisive enough for these specific patterns?" — answer: yes for 4 categories, no for `sudo` (1 false-positive is enough to disqualify) and pipe-to-shell (0 hits but pattern syntax is uncertain).
- **`sudo` false-positive is not a fluke.** Playwright requires `install-deps chromium` for headless browser testing in a fresh container — every Healix test-driven Brief will hit it. The false-positive rate would be approximately 100% on that workload class.
- **Pattern syntax matters.** A deny rule that doesn't match what it claims to match is worse than no rule (false sense of safety). Claude Code's pattern matcher behavior on shell metacharacters (`|`, `&&`, heredocs) is not unambiguous from the docs. The 4 ratified patterns are simple prefix matches; the deferred ones (pipe-to-shell, npm install) require nuanced matching and are explicitly held back.
- **The deny list is data, the policy is the ADR.** Per ADR 005, the file is checked-in and operator-readable. Operators should be able to scan it in one screen.

## Decision

Ship Phase 2 v1 as a deny list of **4 categories**, expressed in `shell/sandbox-claude-settings.json` alongside the existing `permissions.allow` and `hooks` blocks.

### Patterns

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf *.git*)",
      "Bash(rm -rf */.git*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git config --global*)",
      "Bash(npm publish*)",
      "Bash(yarn publish*)",
      "Bash(pnpm publish*)"
    ]
  }
}
```

Pattern conventions:
- Each entry is a single Bash prefix that the Claude Code permission matcher tests against the command string.
- Wildcards are conservative — `*` after a command-prefix to capture argument variations, no mid-pattern wildcards.
- Two `.git`-destruction rules cover both nested (`*/.git*`) and bare (`*.git*`) cases. Some redundancy is intentional; pattern coverage is the priority.

### Telemetry semantics

A denied command surfaces in `major.telemetry_records` per ADR 005:

```json
{
  "observation_type": "tachikoma-bash-observed",
  "payload": {
    "command": "...",
    "decision": "denied",
    "matched_rule": "Bash(npm publish*)",
    "shell_id": "shell-A"
  }
}
```

The audit hook (`shell/sandbox-pretooluse-bash.sh`) does not need to change for v1 because Claude Code itself enforces deny rules (no command exec on match); the hook still records `decision='observed'` for permitted commands. A follow-up could enrich the record by reading Claude Code's permission decision out of the hook's stdin payload, but that is wiring, not policy.

### Deferred

- **Privilege escalation (`sudo`).** Omitted from v1. The single observed case (`sudo npx playwright install-deps chromium`) is a real workload pattern; categorical ban would block test-driven Briefs. Revisit if a finer-grained pattern emerges (e.g. `Bash(sudo apt*)` or `Bash(sudo curl*)`) that captures the dangerous cases without the playwright false-positive.
- **Pipe-to-shell installer (`curl … | sh`).** Pattern syntax is uncertain — Claude Code's matcher behavior on shell pipes is not documented unambiguously, and the safest workaround (deny `curl`/`wget` outright) would false-positive on the 10 legitimate GitHub-API `curl` calls observed in Brief 10. Container isolation remains the v1 protection.
- **Ad-hoc package install (`npm install <pkg>`).** Novel finding from Brief 11 calibration; not in ADR 005's prescribed list. Pattern requires distinguishing bare `npm install` (allowed) from `npm install <pkg-name>` (denied). Worth the effort but needs a separate investigation and likely a small ADR.
- **Pattern-syntax verification.** Before this list ships to production sandboxes, the 8 patterns above should be verified against Claude Code's actual matcher behavior — either by reading the upstream source / docs, or by writing a small test fixture that confirms each rule matches its intended commands without false-positives. **The settings.json change should be gated on this verification step.**

### What this ADR explicitly does not do

- Does not claim the 8 patterns are exhaustive of dangerous Tachikoma behavior.
- Does not introduce new schema or new edge functions. Phase 2 is purely a configuration change.
- Does not cover non-Bash tools (Edit, Write, etc.). Those have their own permission surfaces and require separate calibration.
- Does not commit to a future Phase 3 (e.g. allow-only mode). That is a separate ADR if the deny list proves insufficient.

## Consequences

### Positive

- **Five concrete categories of dangerous Tachikoma behavior are now structurally blocked**, not just observed. The audit-only stance from Phase 1 graduates to enforcement on high-confidence patterns.
- **Operator-readable single file.** `shell/sandbox-claude-settings.json` fits on one screen; a human reviewer can audit the entire policy in seconds.
- **Telemetry distinguishes `denied` from `observed`.** Postmortems on a refused command have a queryable record (`payload.decision='denied'`, `payload.matched_rule=...`).
- **Calibration shortcut is documented.** Future contributors can see why Phase 2 ratified at 1 day rather than 4 weeks; the precedent is "synthetic-but-diverse calibration is sufficient when the categories are crisp."

### Negative

- **Deferred categories are still dangerous.** A Tachikoma that runs `sudo apt install <malicious>` in v1 is not blocked by the deny list (omitted) — only by container isolation. Same for `curl | sh` (pattern uncertainty) and `npm install <pkg>` (novel; deferred).
- **Calibration sample is small.** Two synthetic Briefs is a thin base. A pattern that's clean against this sample could false-positive on a real workload class we haven't observed (e.g. monorepo `pnpm` workflows, Yarn Berry, Bun). Mitigated by treating the deny list as iterable: add patterns when evidence accrues, remove when false-positives surface.
- **Pattern-syntax verification is a load-bearing pre-merge step.** A pattern that doesn't match what it claims to match is worse than no rule. The settings.json change is gated on verification; if verification slips, the ADR is shelfware.
- **Sets a precedent for "synthetic calibration is fine."** ADR 005's premise of organic accumulation is weakened. If a future ADR cites this one as license to skip data-gathering, the calibration discipline erodes. Mitigated by being explicit here: synthetic was acceptable *because the categories were crisp* — not as a general license.

### Follow-on work

- **Pattern-syntax verification.** Cross-check the 8 patterns against Claude Code's official `permissions.deny` documentation (or its source). Confirm match-string semantics for each, especially the `.git`-recursion patterns. Gating step for the settings.json file change.
- **Ship the settings.json change** as a separate small PR after verification. Commit message references this ADR.
- **`shell/sandbox-pretooluse-bash.sh` enrichment.** Optional: read Claude Code's permission decision from the hook stdin payload and surface `decision` + `matched_rule` in the Telemetry Record. Not required for v1.
- **`docs/failure-modes.md`** — add "Tachikoma bash command denied" mode with the operator path: confirm the deny was correct (true positive); if false-positive, narrow the rule and re-deploy.
- **`SPEC.md`** — Phase 2 ratification adds a "Command observability and policy" subsection summarizing the active deny list. Update the URL pointer.
- **Follow-up ADR 009 (or similar)** for the `npm install <pkg>` rule once pattern-syntax investigation gives a clean expression.
- **Operator review cadence.** Monthly: scan the previous month's `decision='denied'` telemetry for false-positives; scan the previous month's top observed verbs for new candidate categories.

### Revisit conditions

- A real command-policy escape during a Run (Phase 1 audit caught it; deny didn't fire, or deny didn't cover the category). Postmortem may add patterns or narrow existing ones.
- A false-positive blocks a legitimate workload at scale (e.g. a new dependent repo's test runner needs `git push --force` for some legitimate reason, hard to imagine but possible). The specific pattern gets carved.
- Claude Code's `permissions.deny` syntax changes upstream (new shape, new semantics). Re-verify all 8 patterns.
- ADR 009 ships the `npm install <pkg>` rule. Revisit this ADR's "Deferred" section to confirm scope.
- The deferred `sudo` category becomes addressable by a fine-grained pattern that captures dangerous targets (`sudo apt`, `sudo curl`, `sudo dd`) without false-positives on `sudo npx playwright install-deps`.

## References

- ADR 005 — Tachikoma command observability and policy via Claude Code permissions (Phase 1; this ADR ratifies Phase 2).
- ADR 006 — Tachikoma stream-json telemetry (sibling write path; same `major.telemetry_records` table).
- `shell/sandbox-claude-settings.json` — the file that holds the deny list (this ADR's data artifact).
- `shell/sandbox-pretooluse-bash.sh` — the audit hook from ADR 005 Phase 1.
- `major.telemetry_records` — the queryable record of every Tachikoma bash exec, observed or denied.
