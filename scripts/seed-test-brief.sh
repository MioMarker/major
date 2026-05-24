#!/usr/bin/env bash
# seed-test-brief.sh — seed ONE ready-for-agent Brief directly, bypassing triage.
#
# Purpose: the smallest possible input for a first green end-to-end smoke of the
# CORE LOOP (claim → implementer → PR → finalize → ready-for-review). It does NOT
# exercise the inbound triage pipeline (GitHub issue → Triage Session → Brief) —
# that's a separate validation (runbook §2.6). This isolates the execution loop.
#
# Why direct inserts (not apply_change_set): the path-blocker and transition
# allowlist are triage-time concerns. claim_next_brief only needs a Brief in
# `ready-for-agent` with a content revision and a clonable git_repository_ref.
# Direct inserts give a deterministic seed with no dependency on triage internals.
#
# Schema applies + this seed run via DIRECT psql, NOT `supabase db push` — the dev
# project shares `_supabase_migrations` history with HealthBite, which blocks push
# (see docs/runbook.md §1.2 and migration 20260509000004_gits_renames.sql header).
#
# Usage:
#   SUPABASE_DB_PASSWORD='<dev-postgres-admin-password>' \
#     scripts/seed-test-brief.sh --repo MioMarker/<scratch-repo>
#
#   Options:
#     --repo <owner/name>   target repo the Shell will clone + open a PR against.
#                           REQUIRED. Refuses MioMarker/healthbite and
#                           MioMarker/healix unless --allow-prod-repo is passed,
#                           so a smoke can't accidentally open PRs on the real
#                           RelyMD work repos.
#     --content-file <path> Markdown PRD body (default: a trivial built-in PRD
#                           that asks for a one-line README change). The PRD's
#                           top `# heading` serves as the effective Brief title
#                           (briefs has no title column; the Shell derives it).
#     --paths <csv>         expected_paths, comma-separated (default: README.md).
#     --base <branch>       base branch (default: dev).
#     --allow-prod-repo     opt in to targeting healthbite/healix (don't, for a smoke).
#
# Env:
#   SUPABASE_DB_PASSWORD   required — dev project's Postgres admin password (1Password).
#   MAJOR_DB_HOST          default db.nuihvxluxdpdjgkvtdih.supabase.co
#   MAJOR_DB_USER          default postgres
#   MAJOR_DB_NAME          default postgres

set -euo pipefail

DB_HOST="${MAJOR_DB_HOST:-db.nuihvxluxdpdjgkvtdih.supabase.co}"
DB_USER="${MAJOR_DB_USER:-postgres}"
DB_NAME="${MAJOR_DB_NAME:-postgres}"

REPO=""
CONTENT_FILE=""
PATHS="README.md"
BASE="dev"
ALLOW_PROD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs a value}"; shift 2 ;;
    --content-file) CONTENT_FILE="${2:?--content-file needs a value}"; shift 2 ;;
    --paths) PATHS="${2:?--paths needs a value}"; shift 2 ;;
    --base) BASE="${2:?--base needs a value}"; shift 2 ;;
    --allow-prod-repo) ALLOW_PROD=1; shift ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "error: unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo "error: SUPABASE_DB_PASSWORD not set (dev Postgres admin password, in 1Password)" >&2
  exit 1
fi
if [[ -z "$REPO" ]]; then
  echo "error: --repo <owner/name> is required (a scratch repo the major-shell-bot PAT can push to)" >&2
  exit 1
fi
if [[ "$ALLOW_PROD" -ne 1 && ( "$REPO" == "MioMarker/healthbite" || "$REPO" == "MioMarker/healix" ) ]]; then
  echo "error: refusing to seed a smoke Brief against production-bound repo '$REPO'." >&2
  echo "       Use a scratch repo, or pass --allow-prod-repo if you really mean it." >&2
  exit 1
fi

# Default PRD: a trivial, low-risk change so the loop has something concrete to do.
if [[ -n "$CONTENT_FILE" ]]; then
  CONTENT="$(cat "$CONTENT_FILE")"
else
  CONTENT="$(cat <<'PRD'
# Smoke test: trivial README change

This is an end-to-end smoke Brief for Major's core loop. The change must be
minimal and safe.

## Task
Append a single line to `README.md`:

    Major smoke test OK.

## Acceptance
- A PR is opened against the base branch with exactly that one-line addition.
- No other files are modified.
PRD
)"
fi

# Convert comma-separated paths into a Postgres array literal, e.g. {README.md,src/x.ts}
PATHS_ARRAY="{$(echo "$PATHS" | sed 's/[[:space:]]//g')}"

echo "==> seeding ready-for-agent Brief"
echo "    repo:   $REPO"
echo "    base:   $BASE"
echo "    paths:  $PATHS_ARRAY"
echo "    db:     $DB_USER@$DB_HOST/$DB_NAME"

# Single transaction. User content is passed via psql variables (:'name'), which
# psql quotes safely — no string interpolation into the SQL text.
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
  -v ON_ERROR_STOP=1 \
  -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" \
  -v repo="$REPO" \
  -v base="$BASE" \
  -v paths="$PATHS_ARRAY" \
  -v content="$CONTENT" <<'SQL'
begin;

with new_brief as (
  insert into major.briefs (
    status, classifications, expected_artifact_type, expected_paths,
    git_repository_ref, base_branch
  ) values (
    'ready-for-agent', '{}', 'git-change', :'paths'::text[],
    :'repo', :'base'
  )
  returning id
),
new_rev as (
  insert into major.brief_content_revisions (
    brief_id, revision_number, content_md, author_actor, reason
  )
  select id, 1, :'content', 'human:smoke-test', 'seed-test-brief'
  from new_brief
  returning id, brief_id
)
update major.briefs b
set current_revision_id = nr.id
from new_rev nr
where b.id = nr.brief_id
returning b.id as brief_id, b.current_revision_id as revision_id,
          b.status, b.git_repository_ref;

commit;
SQL

echo "==> done. The Brief is ready-for-agent; the next Shell poll will claim it."
echo "    Watch it in the UI (/briefs) or: SELECT id,status FROM major.briefs ORDER BY id DESC LIMIT 5;"
