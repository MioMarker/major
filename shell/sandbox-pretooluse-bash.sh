#!/usr/bin/env bash
# Major Shell — PreToolUse hook for Bash tool audit + ad-hoc-package-install
# discrimination (ADR 005 Phase 1 + ADR 009).
#
# Claude Code invokes this script before every Bash tool execution.
#   Audit:    POST observation to major-record-telemetry (decision='observed')
#   Block:    if the command matches the ad-hoc package install pattern,
#             POST a second record (decision='denied') and exit 2 to block.
#
# Required env vars (injected by tachikoma.ts at spawn time):
#   MAJOR_API_BASE_URL        — Supabase functions root (no trailing slash)
#   SUPABASE_SERVICE_ROLE_KEY — service-role key for auth
#   SHELL_ID                  — this Shell's stable identity
#   MAJOR_RUN_ID              — numeric id of the active Run

set -euo pipefail

# Claude Code pipes the PreToolUse event as JSON on stdin.
INPUT=$(cat)

# Parse the command and cwd from the Bash tool input.
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
TOOL_CWD=$(printf '%s' "$INPUT" | jq -r '.tool_input.cwd // ""')

# Unique idempotency key per invocation so hook retries are no-ops.
# uuidgen is present on Linux (uuid-runtime package) and macOS; fall back to
# /proc/sys/kernel/random/uuid on minimal images.
if command -v uuidgen &>/dev/null; then
  INVOCATION_UUID=$(uuidgen | tr '[:upper:]' '[:lower:]')
elif [ -r /proc/sys/kernel/random/uuid ]; then
  INVOCATION_UUID=$(cat /proc/sys/kernel/random/uuid)
else
  INVOCATION_UUID="${MAJOR_RUN_ID}-$(date +%s%N)"
fi

IDEM_KEY="${MAJOR_RUN_ID}:tachikoma-bash:${SHELL_ID}:${INVOCATION_UUID}"

# Build the payload. Sanitization also happens inside major-record-telemetry,
# but we scrub here too so the command never travels in plaintext on the wire.
# jq's --arg auto-escapes the strings; no injection risk.
PAYLOAD=$(jq -n \
  --arg command  "$COMMAND" \
  --arg cwd      "$TOOL_CWD" \
  --arg shell_id "$SHELL_ID" \
  --arg decision "observed" \
  '{ command: $command, cwd: $cwd, shell_id: $shell_id, decision: $decision }')

BODY=$(jq -n \
  --argjson run_id          "$MAJOR_RUN_ID" \
  --arg     observation_type "tachikoma-bash-observed" \
  --argjson payload          "$PAYLOAD" \
  --arg     idempotency_key  "$IDEM_KEY" \
  '{ run_id: $run_id, observation_type: $observation_type, payload: $payload, idempotency_key: $idempotency_key }')

# Fire-and-forget POST. --max-time 5 keeps the hook from stalling the Run if
# the API is slow. Errors are silently ignored — observation failure must never
# abort the Tachikoma (see ADR 005 § "Telemetry parse failures or hook-post
# failures must not abort the Run").
curl --silent --max-time 5 --output /dev/null \
  -X POST "${MAJOR_API_BASE_URL}/major-record-telemetry" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "X-Major-Shell-Id: ${SHELL_ID}" \
  --data "$BODY" || true

# ─────────────────────────────────────────────────────────────────
# ADR 009 — block ad-hoc package installs
# ─────────────────────────────────────────────────────────────────
# Pattern: <pm> (install|add|i) <non-flag-positional-arg>
# Allow:   bare `npm install`, `npm install --legacy-peer-deps`, etc.
# Block:   `npm install jest-expo`, `yarn add foo`, `pnpm i bar`, etc.

if printf '%s' "$COMMAND" | grep -qE '^(npm|yarn|pnpm|bun) (install|add|i)( |$)'; then
  ARGS=$(printf '%s' "$COMMAND" | sed -E 's/^(npm|yarn|pnpm|bun) (install|add|i) ?//')
  # Strip shell noise so the positional check sees only the install command's
  # own args. Without this, `npm install --legacy-peer-deps 2>&1 | tail -20`
  # gets denied because `2>&1` parses as a positional package name (the leading
  # `2` matches the non-flag class). Order matters:
  #   1. Drop fd-only redirects like `2>&1`, `>&2`, `1>&2`.
  #   2. Drop file-target redirects like `> out.txt`, `2>> err.log`, `< in`.
  #   3. Drop everything from the first chained-command separator onward
  #      (`|`, `;`, `&`, `&&`, `||`) so a piped follow-up command can't be
  #      mistaken for a package arg.
  ARGS=$(printf '%s' "$ARGS" | sed -E '
    s/[0-9]*[<>][<>]?&?[0-9]+//g;
    s/[0-9]*[<>][<>]?[[:space:]]*[^[:space:]|&;]+//g;
    s/[[:space:]]*[|;&].*$//;
  ')
  # Match a non-flag positional: a token that is NOT empty, NOT starting with
  # '-', and NOT a chained-command separator. Flag tokens (--foo, -f) and
  # the empty arg (bare install) do not match.
  if printf '%s' "$ARGS" | grep -qE '(^|[[:space:]])[^-[:space:]&|;]'; then
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

    # stderr surfaces to Claude Code as the deny reason.
    echo "blocked by Major Phase 2 hook (ADR 009): ad-hoc package install is not permitted in the Tachikoma sandbox. Bare 'npm install' / 'yarn install' / 'pnpm install' (no package args) is allowed; specific-package installs require a Brief whose expected_paths includes package.json + the lockfile for the relevant package manager." >&2
    exit 2
  fi
fi

# Permitted — exit 0.
exit 0
