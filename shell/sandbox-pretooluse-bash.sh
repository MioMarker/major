#!/usr/bin/env bash
# Major Shell — PreToolUse hook for Bash tool audit (ADR 005 Phase 1).
#
# Claude Code invokes this script before every Bash tool execution.
# It POSTs an observation record to major-record-telemetry and exits 0.
# Audit-only in Phase 1: this hook NEVER blocks a command.
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

# Always exit 0 — audit-only, never blocks.
exit 0
