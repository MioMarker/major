# 009. PreToolUse hook discrimination for ad-hoc package installs

## Status

Accepted

Date: 2026-05-10

## Context

ADR 008 ratified the Phase 2 bash deny list and deferred two categories. One was pipe-to-shell installer (deferred because `permissions.deny` cannot match across shell pipe operators — the matcher splits on `|` per the upstream docs). The other was **ad-hoc package install** — `npm install <pkg-name>`, `yarn add <pkg>`, `pnpm add <pkg>`. The defer rationale was the same shape: `permissions.deny` cannot express "deny when followed by additional non-flag arguments, allow when bare." Deny rules always win, so a `Bash(npm install *)` deny categorically blocks legitimate `npm install` (resolving from `package.json`) too.

This ADR ratifies the rule via a different enforcement point — the `PreToolUse` hook script (`shell/sandbox-pretooluse-bash.sh`) introduced for ADR 005 Phase 1. Hooks fire before Claude Code's permission decision, can inspect the full command string, and can block the call with `exit 2`. The discrimination logic that `permissions.deny` cannot express in declarative form is straightforward bash inside the hook script.

### Calibration evidence

Brief 11 (HealthBite calibration Run, 2026-05-10) hit a missing `jest-expo` dependency mid-Run. Over ~3 minutes the implementer Tachikoma attempted ~18 variants of `npm install jest-expo@55.0.11`, including `npm install --legacy-peer-deps`, `npm install --verbose`, `npm install --prefix /tmp/jest-expo-test`, and `npm cache clean --force && npm install jest-expo@55.0.11`. The Brief eventually parked at `ready-for-human` (correct behavior — the Run did not ship a PR with extraneous `package.json` / `package-lock.json` mutations, because path-blocker would have caught it).

Two distinct concerns surface from this:

1. **Supply-chain attack surface.** A Brief Content (PRD) authored adversarially could direct the Tachikoma to install a malicious package (`npm install evil-pkg`). The hook fires before Claude Code's permission system; container isolation does not protect against an installed npm package that runs install scripts inside the sandbox.
2. **Path-blocker bypass surface.** Ad-hoc installs mutate `package.json` / `package-lock.json`, files that are typically NOT in a Brief's `expected_paths` (only dep-update Briefs would list them). Path-blocker catches this at PR review, but only after wasted Tachikoma turns and Anthropic spend. Catching at exec time is cheaper.

The legitimate use case is bare `npm install` (resolving from a checked-in `package.json` after a fresh clone). The hook discriminates between the two: bare install allowed; install with package-name args blocked.

### Alternatives considered

1. **Continue to defer; rely on path-blocker at PR review.** Rejected. Path-blocker IS the catch today, and it works (Brief 11 demonstrates) — but only after the Tachikoma has burned multiple turns trying to install. Cost: real Anthropic spend + Run latency. The hook catches at exec; path-blocker catches at PR. Both layers are useful but the cheaper one should fire first.

2. **Pre-cache `node_modules` in the Shell image.** Rejected. The Shell image would have to bake in every dependent repo's `node_modules`, kept in sync with each repo's `package-lock.json`. High maintenance, brittle (any `package.json` change breaks the cache), and only addresses the legitimate use case (cold-start dep resolution); does nothing for the supply-chain concern.

3. **Block all `npm install*` via `permissions.deny`; accept that bare `npm install` is also blocked.** Rejected. Bare `npm install` after a fresh clone is the primary legitimate use case — Tachikomas need it to resolve dependencies before running typecheck or tests. Categorical ban would block every test-driven Run.

4. **Hook-level discrimination (this ADR).** Selected. The hook already runs on every Bash exec (ADR 005 Phase 1). Extending it to recognize the `<pm> install <non-flag-arg>` pattern and exit 2 in that case is ~10 lines of bash. The discrimination logic is precise — bare install allowed, with-args blocked — exactly what `permissions.deny` cannot express.

5. **Extend the rule to `npm install --save-dev`, `--save-exact`, etc. (flag-only installs).** Rejected for v1. Bare `npm install --legacy-peer-deps` (flag-only, resolves from package.json) is legitimate. The discriminator should be "is the first non-flag positional arg a package name" — if no positional arg, allow; if positional arg, block. Flags don't change the verdict.

### Forces

- **Hook is already wired.** ADR 005 Phase 1 ships `shell/sandbox-pretooluse-bash.sh` running on every Bash invocation. Adding a deny-on-pattern branch is a small extension, not a new integration.
- **Hooks fire pre-decision and can block.** Per Claude Code's docs (https://code.claude.com/docs/en/permissions.md § "Extend permissions with hooks"): `exit 2` from a `PreToolUse` hook blocks the tool call. Hook decisions don't override `permissions.deny` (deny still wins) but can add denials beyond what deny rules express.
- **Pattern is decidable in bash.** A regex like `^(npm|yarn|pnpm|bun) (install|add|i)( |$).*[^-]\S*` (with refinement for flag-handling) discriminates ad-hoc-add from bare-install. Edge cases exist (chained commands, complex flag orderings) but the false-positive risk is low because the legitimate forms are limited.
- **Telemetry preservation.** The hook currently records every observed command as `decision='observed'`. The new branch records `decision='denied'` with `matched_rule='ad-hoc-package-install'` before `exit 2`. Future operators can `select * from telemetry_records where payload->>'decision' = 'denied'` and audit.
- **Per-package-manager coverage.** npm is the immediate target (Brief 11 evidence), but yarn/pnpm/bun share the same supply-chain shape. Cover all four.

## Decision

Extend `shell/sandbox-pretooluse-bash.sh` (the existing Phase 1 audit hook) with an ad-hoc-package-install discriminator that blocks installs of specific packages while permitting bare resolution from `package.json`.

### Discrimination logic

```bash
# After existing telemetry POST, before final exit 0:
# Detect: <pm> install/add <pkg-name> with at least one non-flag positional arg
if printf '%s' "$COMMAND" | grep -qE '^(npm|yarn|pnpm|bun) (install|add|i) '; then
  # Strip the leading "<pm> <subcmd> " then check for any non-flag positional.
  ARGS=$(printf '%s' "$COMMAND" | sed -E 's/^(npm|yarn|pnpm|bun) (install|add|i) //')
  # A non-flag positional is any whitespace-separated token NOT starting with "-"
  # and NOT matching a chained-command separator.
  if printf '%s' "$ARGS" | grep -qE '(^|[[:space:]])[^-[:space:]&|;]'; then
    # Re-record as denied for audit, then block.
    DENIED_PAYLOAD=$(jq -n \
      --arg command  "$COMMAND" \
      --arg cwd      "$TOOL_CWD" \
      --arg shell_id "$SHELL_ID" \
      --arg decision "denied" \
      --arg rule     "ad-hoc-package-install" \
      '{ command: $command, cwd: $cwd, shell_id: $shell_id, decision: $decision, matched_rule: $rule }')
    DENIED_BODY=$(jq -n \
      --argjson run_id          "$MAJOR_RUN_ID" \
      --arg     observation_type "tachikoma-bash-observed" \
      --argjson payload          "$DENIED_PAYLOAD" \
      --arg     idempotency_key  "${IDEM_KEY}-denied" \
      '{ run_id: $run_id, observation_type: $observation_type, payload: $payload, idempotency_key: $idempotency_key }')
    curl --silent --max-time 5 --output /dev/null \
      -X POST "${MAJOR_API_BASE_URL}/major-record-telemetry" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "X-Major-Shell-Id: ${SHELL_ID}" \
      --data "$DENIED_BODY" || true
    # Stderr is surfaced to Claude Code as the deny reason.
    echo "blocked by Major Phase 2 hook (ADR 009): ad-hoc package install '$COMMAND' is not permitted in the Tachikoma sandbox. Bare 'npm install' / 'yarn install' / 'pnpm install' (no package args) is allowed; specific-package installs require a Brief whose expected_paths includes package.json + the package-lock for the relevant package manager." >&2
    exit 2
  fi
fi

# Existing audit-record POST + exit 0 below.
```

### What this denies

- `npm install <pkg>`, `npm i <pkg>`, `npm install <pkg> --save-dev`, `npm install --save-dev <pkg>`
- `yarn add <pkg>`, `yarn add <pkg> --dev`
- `pnpm add <pkg>`, `pnpm install <pkg>` (pnpm's `install` accepts package args same as npm)
- `bun add <pkg>`, `bun install <pkg>`

### What this allows

- Bare `npm install`, `npm i`, `yarn install`, `yarn`, `pnpm install`, `pnpm i`, `bun install`
- `npm install --legacy-peer-deps`, `npm install --no-audit`, etc. (flag-only)
- All other `npm`/`yarn`/`pnpm`/`bun` subcommands (`run`, `test`, `audit`, `ls`, `view`, `cache`, etc.)
- Anything not matching the leading `(npm|yarn|pnpm|bun) (install|add|i) ` pattern

### Telemetry semantics

A blocked invocation produces TWO telemetry records (the existing observed one with `decision='observed'`, plus a second with `decision='denied'` and `matched_rule='ad-hoc-package-install'`). The second record uses the same idempotency key with `-denied` suffix to keep the pair distinct. Operators can query denied commands directly:

```sql
select run_id, payload->>'command', created_at
from major.telemetry_records
where observation_type = 'tachikoma-bash-observed'
  and payload->>'decision' = 'denied'
  and payload->>'matched_rule' = 'ad-hoc-package-install'
order by created_at desc;
```

### Operator path for legitimate package installs

A Brief whose actual purpose is "add a dependency" should:

1. List `package.json` and the relevant lockfile (`package-lock.json` for npm, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`) in `expected_paths`.
2. Have its PRD explicitly state which packages are being added and why.
3. The reviewer Tachikoma flags any extra/unintended packages.

The hook does NOT consult `expected_paths` (the hook runs in the sandbox, doesn't know the Cyberbrain state). The hook is a categorical block; the path-blocker handles "is this Brief allowed to mutate package.json?" separately. Both layers stack.

### What this ADR explicitly does not do

- Does not cover Python (`pip install <pkg>`), Ruby (`gem install`), Go (`go get`), Rust (`cargo add`), or any other language ecosystem. Same shape, separate ADR if/when those become realistic surfaces.
- Does not cover dev-shell installations (`brew install`, `apt install`, `apk add`). Those would also need `sudo` or system perms in the sandbox; container isolation is the v1 protection. Separate ADR if needed.
- Does not introduce new schema. The two telemetry records flow through the existing `major.telemetry_records` table via the existing `major-record-telemetry` endpoint.
- Does not address pipe-to-shell (`curl … | sh`). That's a separate deferred category from ADR 008; deferred per its own analysis.
- Does not extend to global installs (`npm install -g <pkg>`) as a special case — `-g` is a flag, but the ALSO-required positional package arg is what triggers the block. So `npm install -g typescript` IS blocked because `typescript` is a non-flag positional. Correct behavior.

## Consequences

### Positive

- **Closes the supply-chain attack surface for the JS ecosystem.** A Brief Content directing the Tachikoma to install a malicious package fails immediately at the hook level, with a `decision='denied'` audit record.
- **Catches path-blocker-bypass attempts cheaply.** Ad-hoc dep adds that would have been caught at PR review are caught at exec instead — saves Tachikoma turns and Anthropic spend.
- **Telemetry distinguishes the case.** Operators see `decision='denied' matched_rule='ad-hoc-package-install'` records and can correlate them to specific Briefs. Audit trail is queryable, not buried in stdout.
- **Reuses existing infrastructure.** No new endpoint, no new schema, no new file. The hook already runs; this adds a branch.

### Negative

- **Bash regex discriminator has edge cases.** `npm install foo bar baz` is correctly blocked (multi-package); `npm install` is correctly allowed; `npm install -- --some-passthrough` (using `--` to end flag parsing) — does the `--` count as a non-flag positional? The regex above treats `-` as flag-leading; `--` would NOT match `[^-...]`, so it's allowed. Edge cases like `npm install ./local-pkg` (filesystem path install) ARE blocked because `./` doesn't start with `-`. That's likely correct (filesystem-path installs are also unusual mid-Run) but may need a carve-out if it false-positives in practice.
- **Heredoc / multi-line wrappers.** A Tachikoma constructing a heredoc that contains `npm install <pkg>` inside a shell-script body would NOT trigger this regex, because the leading command is `bash` or `sh`, not `npm`. Defense-in-depth: container isolation still bounds the blast radius. The regex is for the common direct-invocation case.
- **Per-package-manager coverage matrix.** New package managers (deno, jsr, etc.) don't get the rule until the regex is updated. Manual maintenance burden, low — these don't appear often.
- **Hook script complexity grows.** ADR 005 Phase 1 hook was 65 lines; this branch adds ~30 lines. Still a single bash script, still readable. If the hook script grows past ~150 lines, consider extracting helpers or rewriting in a more structured language.
- **Two telemetry records per blocked invocation.** Storage grows by 2x on the (rare) blocked case. Negligible given the rate.

### Follow-on work

- **Implement the hook extension.** Update `shell/sandbox-pretooluse-bash.sh` with the discriminator. Small PR, ~30 lines added.
- **Hook test fixtures.** A small bash test fixture that runs the hook against a corpus of test commands (bare install, with-pkg install, unrelated commands) and confirms exit codes. `shell/sandbox-pretooluse-bash.test.sh`.
- **Brief 11 retry.** With this hook live, re-arming Brief 11 would (correctly) block the ad-hoc install attempts immediately. The Tachikoma would either (a) park-for-human faster, or (b) recognize the block and write a more accurate park message. Useful as a real-world test of the rule.
- **`docs/failure-modes.md` § 19 update.** The "Tachikoma bash command denied" mode (added in the ADR 007/008 doc sweep) gains a sub-case for `matched_rule='ad-hoc-package-install'`.
- **`SPEC.md` "Command observability and policy" subsection.** Move the `npm install <pkg>` line out of "deferred" and into "active" once the hook ships.
- **Pre-merge test plan.** Bash unit tests run via `bash shell/sandbox-pretooluse-bash.test.sh`. Manual smoke: drop the hook into a scratch sandbox, attempt blocked + allowed commands, confirm exit codes and telemetry records.

### Revisit conditions

- **A new package manager surfaces with different syntax.** Add it to the regex.
- **A legitimate workload pattern hits the false-positive case** (e.g. a real Brief whose `expected_paths` includes `package.json` and whose work genuinely requires a runtime `npm install <pkg>`). Carve out via a marker file in the sandbox (e.g. `/work/.major/allow-pkg-installs`) that the hook reads.
- **The regex turns out to be wrong.** A blocked command that should have been allowed (or vice versa) shows up in production. Open an issue and tighten the regex.
- **Hook script bloat.** If accumulated rules push the script past ~150 lines, factor into a helper module or rewrite (Python? Deno? — same constraints, different syntax).
- **Claude Code adds a richer hook protocol** (e.g. structured per-rule deny output, context about the matched permission rule). Re-evaluate whether the discriminator should move into `permissions.deny` syntax.

## References

- ADR 005 — Tachikoma command observability and policy (Phase 1 audit hook this ADR extends).
- ADR 008 — Tachikoma bash deny list v1 (deferred this rule citing `permissions.deny` expressivity).
- `shell/sandbox-pretooluse-bash.sh` — the file this ADR modifies.
- `shell/sandbox-claude-settings.json` — declarative deny list (this ADR's rule lives in the hook, not here).
- `major.telemetry_records` — queryable record of observed and denied invocations.
- https://code.claude.com/docs/en/permissions.md § "Extend permissions with hooks" — confirms `PreToolUse exit 2` is the deny mechanism.
- Brief 11 calibration data (Run #10595, 2026-05-10) — the evidence that motivated this ADR.
