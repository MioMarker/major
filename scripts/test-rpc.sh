#!/usr/bin/env bash
# scripts/test-rpc.sh — run the pgTAP RPC test suite.
#
# Usage:
#   scripts/test-rpc.sh            # uses $DATABASE_URL
#   DATABASE_URL=postgres://... scripts/test-rpc.sh
#
# The script installs the pgTAP extension if it is not already present,
# then runs all tests/rpc/*.test.sql files via pg_prove.
#
# If DATABASE_URL is unset, the script exits 0 with a warning so that
# `npm test` passes locally without a Postgres instance. CI must set
# DATABASE_URL before running npm test.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC_DIR="$REPO_ROOT/tests/rpc"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "⚠  DATABASE_URL not set — skipping pgTAP RPC tests." >&2
  echo "   To run: DATABASE_URL=postgres://... scripts/test-rpc.sh" >&2
  exit 0
fi

# Check that pg_prove is available.
if ! command -v pg_prove &>/dev/null; then
  echo "⚠  pg_prove not found — install pgTAP (brew install pgtap on macOS)." >&2
  echo "   To run: DATABASE_URL=postgres://... scripts/test-rpc.sh" >&2
  exit 1
fi

# Ensure pgtap extension exists in the target database.
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pgtap;" \
  -c "CREATE SCHEMA IF NOT EXISTS _test;" \
  >/dev/null 2>&1 || true

echo "▶ Running pgTAP RPC tests against $DATABASE_URL ..."
cd "$REPO_ROOT"

pg_prove \
  --dbname "$DATABASE_URL" \
  --ext ".sql" \
  --verbose \
  "$RPC_DIR"/claim_next_brief.test.sql \
  "$RPC_DIR"/finalize_run.test.sql \
  "$RPC_DIR"/apply_change_set.test.sql \
  "$RPC_DIR"/reaper_sweep.test.sql

echo "✓ pgTAP RPC tests passed."
