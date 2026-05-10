# 005. Tachikoma command observability and policy via Claude Code permissions

## Status

Accepted

Date: 2026-05-09

## Context

Major's deterministic authorization is currently **path-axis only**. The path-blocker (ADR 002) gates Triage Change Sets by which paths they propose to modify. The Shell sandbox discipline (`.claude/rules/shell/sandbox-discipline.md`) isolates Tachikoma work to `/work/repo` and cleans the working directory between Briefs.

Both controls answer the question *what files can the Tachikoma touch?* Neither answers *what commands can the Tachikoma run?*

Today, `shell/tachikoma.ts:177` invokes Claude Code with `--dangerously-skip-permissions`, and the comment at `:165` declares "container is the trust boundary." That posture was deliberate while the orchestrator was being stood up: a single sandbox per Run, cleaned between Briefs, with the Instruction Trust Boundary opener as the only soft check on what the Tachikoma chooses to exec. This ADR deliberately revises that posture.

The container alone is insufficient as a control. A Tachikoma operating against a Brief whose Content directs it (or whose author negligently encouraged it) to run a destructive command — `rm -rf /work/repo/.git`, `git push --force`, `npm install some-malicious-package`, `curl … | sh` — produces no audit trail, no telemetry, and no defense beyond the Instruction Trust Boundary opener. The path-blocker is non-bypassable for *changes that propose to land*; nothing comparable observes *commands that actually run during the work*. Path is one axis of authorization (ADR 002, file axis); command is another (this ADR). They are orthogonal.

Major does not need to reinvent a permission system to address this. Claude Code already ships one — `PreToolUse` hooks, `.claude/settings.json` allow/deny lists, fine-grained permission rules — and the Shell sandbox is a natural place to drop a `.claude/settings.json`-shaped policy file at clone time. The right move is to use that machinery, audit-first, and let evidence drive any future enforcement.

### Alternatives considered

1. **Keep `--dangerously-skip-permissions` and trust the container alone.** Rejected: zero audit trail of what commands ran, no defense against PRD-authored adversarial instructions beyond the Instruction Trust Boundary opener (which is a prompt and therefore advisory), and no calibration data with which to author any future enforcement. The container limits *blast radius*; it does not classify or record destructive operations against the Run's own working tree.

2. **The original Proposal 02 design: a new `major.command_risk_rules` table read by a Major-built subprocess wrapper before every Tachikoma exec.** Rejected on two grounds. First, it reinvents a permission system Claude Code already has; the wrapper would carry deny-list parsing, regex evaluation, and exec-interception code that duplicates what `.claude/settings.json` already expresses. Second, the proposed three-tier hierarchy (org / project / brief) was coupled to the deferred Proposal 01, which is itself premature at two repos and two devs. Reuse the upstream tool; ship narrower.

3. **Rely on Claude Code's defaults without configuration.** Rejected: Anthropic's defaults are tuned for general use, not for Major's specific blast radius into HealthBite and Healix. Major has no visibility into what gets refused under defaults, no Major-specific patterns (our `gh` token semantics, our migration discipline, our `.git`-is-load-bearing constraint) reflected in those defaults, and no audit record when a refusal happens.

### Forces

- **Two axes, two gates.** Path and command are independent. Both gates must hold.
- **Audit before enforcement.** Major has no calibration data on what Tachikomas actually exec today. Authoring an enforcement list in advance is guessing. Observation first; enforcement when the data warrants it.
- **First-party tooling.** The Shell consumes Claude Code as Anthropic ships it. Whatever observability and enforcement land here ride on upstream features, not a forked or wrapped subprocess.
- **Telemetry write path is the same one ADR 006 uses.** The hook writes Telemetry Records, not Events — per CONTEXT.md, observation of Tachikoma behavior is non-lifecycle, so it lands in `major.telemetry_records`. ADR 006's stream-json telemetry uses the same table for the same reason; they are siblings.
- **Secret hygiene.** `.claude/rules/shell/sandbox-discipline.md` § "Never Log Secrets" applies to bash exec telemetry as much as to any other persisted Tachikoma stdout. The hook payload runs through the existing sanitizer before insert.

## Decision

Major drops `--dangerously-skip-permissions`, configures Claude Code's `PreToolUse` hook on `Bash` to write a Telemetry Record per command exec, and defers enforcement until observation data accrues.

The work is sequenced in two phases.

### Phase 1 — Audit-only

1. Remove `--dangerously-skip-permissions` from the Tachikoma argv in `shell/tachikoma.ts`. Update the surrounding comment block to reference this ADR.
2. The Shell drops a `.claude/settings.json` into the sandbox at clone time (alongside the cloned repo's tree, scoped to that working directory) with a `PreToolUse` hook on the `Bash` tool. The hook posts the command line, working directory, Run id, and Shell id to a Major endpoint.
3. The endpoint writes a Telemetry Record:
   - `observation_type = 'tachikoma-bash-observed'`
   - `payload = { command, cwd, decision: 'observed', shell_id, sequence }`
   - `idempotency_key` shape: `(run_id, 'tachikoma-bash', shell_id, sequence)` — sequence is the Run-scoped counter ADR 006 also uses (`runs.tachikoma_event_sequence`).
4. The hook **observes only**. No exec is blocked in Phase 1. The Tachikoma proceeds in whatever permission posture Claude Code's defaults grant; Major's contribution is the audit trail.

Telemetry parse failures or hook-post failures must not abort the Run. Observation is non-lifecycle; degraded observation is acceptable.

### Phase 2 — Evidence-based deny list (deferred ~4 weeks)

After ~4 weeks of Phase 1 data:

1. Author a small deny list as `shell/sandbox-claude-settings.json` — a `.claude/settings.json`-shaped file checked into the repo. The Shell drops it into each cloned sandbox in place of the audit-only file.
2. The deny list is operator-readable, evidence-driven, and short. Patterns to consider for inclusion (final list informed by Phase 1 data):
   - destructive operations against the working tree's `.git` directory,
   - force-push and global-config mutations against `git`,
   - pipe-to-shell installers from arbitrary URLs,
   - publishing operations (`npm publish` and equivalents),
   - privilege escalation (`sudo`).
3. Enforcement happens inside Claude Code's existing permission system. There is no Major-built wrapper. Refusals surface in Telemetry as `decision = 'denied'` with the matched rule, alongside the existing `decision = 'observed'` records.

The seed list lands as part of a follow-up PR with its own commit, not in this ADR. The list is data, the ADR is the policy.

### What this ADR explicitly does not do

- It does not introduce `major.command_risk_rules` or any new Cyberbrain table for command policy. Policy is expressed as `.claude/settings.json` content, version-controlled with the repo.
- It does not couple to Proposal 01's deferred three-tier hierarchy. If a hierarchy is ever needed for the command axis, it is a separate ADR; this ADR is single-tier.
- It does not block on Phase 2. Phase 1 is a complete and independently valuable change.

## Consequences

### Positive

- The deliberate "container is the trust boundary" stance is replaced with a recorded one. Every Tachikoma bash exec is a Telemetry Record; postmortems and weekly review are possible.
- Reuses Claude Code's permission system. No subprocess wrapper to maintain, no regex engine to ship, no exec-interception code to debug.
- Phase 1 ships immediately and is reversible: drop the hook, restore the flag, no data migration. Phase 2 is data-driven, not guess-driven.
- The seeded deny list, when it lands, is short and operator-readable — the kind of thing a human can audit in a single review.
- Stacks cleanly with ADR 002 (the file axis) and ADR 006 (the telemetry write path). Three orthogonal controls, each in its own lane.

### Negative

- **Phase 1 has no enforcement.** A genuinely destructive command in the Phase 1 window is not blocked; the container is still the only structural defense. The mitigation is that Phase 1 is bounded (~4 weeks) and the per-Brief sandbox cleanup limits blast radius.
- **Hook reliability is a load-bearing assumption.** A Tachikoma whose hook silently fails to post produces a Run with no command audit trail. Mitigated by treating hook-post failures as Telemetry-degraded, not Run-failed, and surfacing aggregate hook health monthly.
- **Pattern drift on the eventual deny list.** Regexes in `.claude/settings.json` rot the same way any deny list rots — a new package manager command shape (`bun add`) might bypass an `npm`-based pattern. Mitigated by monthly review of the most common observed commands.
- **Doesn't cover network destinations or filesystem operations outside the `Bash` tool.** This ADR addresses one axis of one tool. Network-axis authorization, `Edit`-tool gating, and any future tool-specific policy are separate problems and separate ADRs.

### Follow-on work

- Update `SPEC.md` to add a "Command observability" subsection alongside "Path-Blocker" once Phase 1 ships.
- Update `.claude/rules/shell/sandbox-discipline.md` to document the hook's contract and the Phase 2 sandbox-settings file location.
- Telemetry dashboard: top 20 observed commands per week. Drives the Phase 2 seed list and ongoing refinement.
- Update `docs/failure-modes.md` to add a "Command policy violation during Run" mode once Phase 2 enforcement is live, with the recovery path for `decision = 'denied'`.
- Author `shell/sandbox-claude-settings.json` after the Phase 1 observation window. Separate PR, separate review.

### Revisit conditions

- When a real command-policy escape occurs in the wild (Phase 1 or Phase 2). Postmortem may narrow the seed list, harden the hook, or expand to a second tool.
- When network-axis authorization becomes a concrete need. Separate ADR; do not retrofit into this one.
- When Proposal 01 (hierarchical policy scope) is reconsidered. If a hierarchy lands for path-blocker, evaluate whether the command axis warrants the same shape — but only then, not preemptively.
- When Claude Code's permission-system shape changes upstream (new hook event, deprecated `PreToolUse`). The hook contract and `.claude/settings.json` schema both belong to Anthropic; we follow.

## References

- ADR 002 — Path-Blocker Rule (file axis; this ADR is the command axis).
- ADR 006 — Tachikoma stream-json telemetry (shares the `major.telemetry_records` write path).
- `.claude/rules/shell/sandbox-discipline.md` § "Never Log Secrets" — same hygiene applies to bash exec telemetry.
- `shell/tachikoma.ts:165` — the "container is the trust boundary" comment this ADR revises.
- `shell/tachikoma.ts:177` — the `--dangerously-skip-permissions` flag this ADR drops.
- `docs/plans/factory-borrows/01-hierarchical-policy-scope.md` — deferred; this ADR explicitly does not couple to it.
