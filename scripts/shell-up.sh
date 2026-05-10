#!/usr/bin/env bash
# shell-up.sh — boot a Major Shell from ~/Projects/major/.env
#
# Usage:
#   scripts/shell-up.sh                  boot shell-A in foreground
#   scripts/shell-up.sh shell-B          boot a differently-named Shell
#   scripts/shell-up.sh --build          rebuild the image first
#   scripts/shell-up.sh --build shell-B  rebuild then boot shell-B
#
# Env overrides:
#   MAJOR_ENV_FILE     path to env file (default: ~/Projects/major/.env)
#   MAJOR_SHELL_IMAGE  image tag (default: major-shell:latest)
#
# Notes:
#   - --rm: container removed on exit (matches existing pattern; no detached daemon to track).
#   - --env-file: secrets sourced from .env; no inline values in the command line.
#   - SHELL_ID is forced to match the container name so they stay in lockstep
#     even when you boot a non-default Shell (e.g. shell-B).

set -euo pipefail

ENV_FILE="${MAJOR_ENV_FILE:-$HOME/Projects/major/.env}"
IMAGE="${MAJOR_SHELL_IMAGE:-major-shell:latest}"
SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/shell"

BUILD=0
NAME="shell-A"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) BUILD=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) NAME="$1"; shift ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: env file not found at $ENV_FILE" >&2
  echo "  create it (mode 600) with SHELL_ID, MAJOR_API_BASE_URL, SUPABASE_SERVICE_ROLE_KEY," >&2
  echo "  GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN" >&2
  exit 1
fi

if [[ "$BUILD" -eq 1 ]]; then
  echo "==> rebuilding $IMAGE from $SHELL_DIR"
  docker build -t "$IMAGE" "$SHELL_DIR"
fi

if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "==> stopping existing $NAME"
  docker stop "$NAME" >/dev/null
fi

echo "==> running $IMAGE as $NAME (env from $ENV_FILE)"
exec docker run --rm \
  --name "$NAME" \
  --env-file "$ENV_FILE" \
  -e "SHELL_ID=$NAME" \
  "$IMAGE"
