#!/usr/bin/env bash
# Test fixture for sandbox-pretooluse-bash.sh — verifies the ADR 009
# ad-hoc-package-install discriminator without making any HTTP calls.
#
# Strategy: invoke the hook with stub env vars pointing at a localhost
# port nothing listens on. The hook's curl call fails silently (per the
# || true), so the test only observes the script's exit code, which is
# what the discriminator drives.
#
# Run: bash shell/sandbox-pretooluse-bash.test.sh
# Exit 0 on all-pass, exit 1 on any failure.

set -u

HOOK="$(cd "$(dirname "$0")" && pwd)/sandbox-pretooluse-bash.sh"

# Stub env: any URL that won't connect. curl fails, hook logic still runs.
export MAJOR_API_BASE_URL="http://127.0.0.1:1"   # closed port
export SUPABASE_SERVICE_ROLE_KEY="stub-key"
export SHELL_ID="test-shell"
export MAJOR_RUN_ID="0"

PASS=0
FAIL=0
FAIL_DETAILS=()

# expect_exit <expected-code> <description> <command-string>
expect_exit() {
  local want="$1"; local desc="$2"; local cmd="$3"
  local input
  input=$(jq -n --arg c "$cmd" '{ tool_input: { command: $c } }')
  local got=0
  printf '%s' "$input" | "$HOOK" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    PASS=$((PASS + 1))
    printf "  ✓ %s\n" "$desc"
  else
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("$desc — wanted exit $want, got $got — cmd: $cmd")
    printf "  ✗ %s — wanted exit %s, got %s\n" "$desc" "$want" "$got"
  fi
}

echo "== ADR 009: ad-hoc package install discriminator =="
echo ""
echo "-- Cases that MUST be blocked (exit 2) --"

expect_exit 2 "npm install with package name"          "npm install jest-expo"
expect_exit 2 "npm install with versioned package"     "npm install jest-expo@55.0.11"
expect_exit 2 "npm install with --save-dev flag + pkg" "npm install --save-dev jest-expo"
expect_exit 2 "npm install with pkg + --save-dev flag" "npm install jest-expo --save-dev"
expect_exit 2 "npm i (short form) with package"        "npm i lodash"
expect_exit 2 "npm install global with package"        "npm install -g typescript"
expect_exit 2 "npm install with --prefix path + pkg"   "npm install jest-expo --prefix /tmp/foo"
expect_exit 2 "yarn add with package"                  "yarn add lodash"
expect_exit 2 "yarn add with package + --dev"          "yarn add lodash --dev"
expect_exit 2 "pnpm add with package"                  "pnpm add lodash"
expect_exit 2 "pnpm install with package"              "pnpm install lodash"
expect_exit 2 "bun add with package"                   "bun add lodash"
expect_exit 2 "bun install with package"               "bun install lodash"
expect_exit 2 "npm install multiple packages"          "npm install foo bar baz"

echo ""
echo "-- Cases that MUST be allowed (exit 0) --"

expect_exit 0 "bare npm install"                       "npm install"
expect_exit 0 "bare npm i"                             "npm i"
expect_exit 0 "bare yarn install"                      "yarn install"
expect_exit 0 "bare pnpm install"                      "pnpm install"
expect_exit 0 "bare bun install"                       "bun install"
expect_exit 0 "npm install with flag-only"             "npm install --legacy-peer-deps"
expect_exit 0 "npm install with multiple flags"        "npm install --legacy-peer-deps --no-audit"
expect_exit 0 "yarn install with flag"                 "yarn install --frozen-lockfile"
expect_exit 0 "npm run typecheck"                      "npm run typecheck"
expect_exit 0 "npm test"                               "npm test"
expect_exit 0 "npm cache clean"                        "npm cache clean --force"
expect_exit 0 "npm ls"                                 "npm ls"
expect_exit 0 "npm config get"                         "npm config get prefix"
expect_exit 0 "npm view"                               "npm view jest-expo"
expect_exit 0 "git status"                             "git status"
expect_exit 0 "ls"                                     "ls -la"
expect_exit 0 "node script"                            "node ./scripts/foo.js"
expect_exit 0 "npx command"                            "npx tsc --noEmit"

echo ""
echo "-- Bare install combined with shell redirects/pipes (regression for false positives) --"

# Real Tachikoma commands from 2026-05-10 Briefs 15/16 that the discriminator
# was incorrectly denying. The leading `2` of `2>&1` matched the non-flag
# positional class; same root cause for `> out.txt` after a bare install.
expect_exit 0 "bare install + stderr redirect + pipe"  "npm install 2>&1 | tail -20"
expect_exit 0 "flag install + stderr redirect + pipe"  "npm install --legacy-peer-deps 2>&1 | tail -20"
expect_exit 0 "flag install + stderr redirect (= form)" "npm install --include=dev 2>&1 | tail -5"
expect_exit 0 "bare install with stdout file redirect" "npm install > install.log"
expect_exit 0 "bare install with appended stderr file" "npm install 2>> err.log"
expect_exit 0 "bare install with combined &> redirect" "npm install &> all.log"
expect_exit 0 "bare install piped to grep"             "npm install | grep WARN"
expect_exit 0 "flag install chained with &&"           "npm install --no-audit && echo done"
expect_exit 0 "flag install chained with ;"            "npm install --no-audit; ls"

echo ""
echo "-- Package install combined with redirects/pipes MUST still block --"

# Defensive: stripping shell noise must not let real package installs leak through.
expect_exit 2 "package install with stderr redirect"   "npm install jest-expo 2>&1"
expect_exit 2 "package install with file redirect"     "npm install jest-expo > out.log"
expect_exit 2 "package install piped"                  "npm install jest-expo | tail -5"
expect_exit 2 "package install chained &&"             "npm install jest-expo && echo done"
expect_exit 2 "package install chained ;"              "npm install jest-expo; ls"

echo ""
echo "== Result: $PASS passed, $FAIL failed =="

if (( FAIL > 0 )); then
  echo ""
  echo "Failures:"
  for f in "${FAIL_DETAILS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

exit 0
