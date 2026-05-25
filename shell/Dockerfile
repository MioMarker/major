# Major Shell — base image for Tachikoma execution sandboxes.
#
# A single container = one Shell (per SPEC §Shell architecture).
# It runs `shell/main.ts` as a long-lived daemon that:
#   1. Heartbeats to Major's API to register itself in `major.shells`.
#   2. Polls `major-list-briefs?status=ready-for-agent` and attempts to claim.
#   3. On claim: clones the target repo, runs implementer + reviewer Tachikoma
#      phases (each a fresh `claude` subprocess), finalizes the Run.
#
# Runtime choice: Node 20 + TypeScript (compiled at build time via `tsc`).
# Deno is also installed because target repos (HealthBite eval pipeline) use
# `deno task ...` for verification — the implementer Tachikoma may invoke it.

FROM node:20-bookworm

# ────────────────────────────────────────────────────────────────────
# System dependencies: git (clone repos), curl/jq (debug), build tools
# (so npm install can compile native deps if any), CA certs (HTTPS to
# Supabase + GitHub).
# ────────────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      jq \
      ca-certificates \
      build-essential \
      python3 \
    && rm -rf /var/lib/apt/lists/*

# ────────────────────────────────────────────────────────────────────
# GitHub CLI (`gh`). Used by:
#   - Tachikoma implementer prompt: `gh pr create`, `gh pr review`
#   - main.ts CI poller: `gh pr checks`, `gh run view`
# Authenticated via $GITHUB_TOKEN env var (no interactive login).
# ────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ────────────────────────────────────────────────────────────────────
# Deno — required for repos that run `deno task` in CI (e.g. HealthBite's
# eval pipeline). Installed system-wide.
# ────────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deno.land/install.sh \
      | DENO_INSTALL=/usr/local sh -s -- --no-modify-path

# ────────────────────────────────────────────────────────────────────
# Claude Code CLI — the Tachikoma. Installed as the `agent` user (below).
# Runs in --print mode inside the sandbox; per ADR 005, a PreToolUse hook
# records every Bash command to major-record-telemetry for observability.
# ────────────────────────────────────────────────────────────────────
RUN groupadd -g 1100 agent \
    && useradd -m -d /home/agent -s /bin/bash -u 1100 -g 1100 agent \
    && mkdir -p /home/agent/.claude /home/agent/.claude/projects \
    && chown -R agent:agent /home/agent

USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

# Switch back to root to install Shell code globally; final USER below.
USER root

# ────────────────────────────────────────────────────────────────────
# Shell code lives at /opt/major-shell. Compiled via `tsc` at build time
# so the container can boot quickly (no ts-node overhead at runtime).
# Layer order: package*.json first → cache npm install across code edits.
# ────────────────────────────────────────────────────────────────────
WORKDIR /opt/major-shell
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY main.ts tachikoma.ts stream-json-parser.ts planner-helpers.ts repair-helpers.ts ci-helpers.ts ./
COPY prompts/ ./prompts/
COPY sandbox-pretooluse-bash.sh sandbox-claude-settings.json ./
RUN chmod +x sandbox-pretooluse-bash.sh
RUN npx tsc

# tachikoma.ts resolves prompt paths via path.join(__dirname, "prompts").
# After tsc, __dirname for the running .js file is /opt/major-shell/dist/,
# so prompt .md files must live alongside the compiled output. We copy just
# the markdown (NOT `cp -r prompts dist/prompts`) because `dist/prompts/`
# already exists — tsc compiled `prompts/versions.ts` into it. A recursive
# copy would create `dist/prompts/prompts/`.
RUN cp prompts/*.md dist/prompts/

# Make the Shell code readable by the agent user.
RUN chown -R agent:agent /opt/major-shell

# ────────────────────────────────────────────────────────────────────
# Per-Run sandbox root. Each Brief gets a fresh subdir at
# /work/<repo-name>/ — wiped between Runs (see main.ts cleanupSandbox).
# Mountable from the host if you want to inspect artifacts post-run.
# ────────────────────────────────────────────────────────────────────
RUN mkdir -p /work && chown -R agent:agent /work
WORKDIR /work

# ────────────────────────────────────────────────────────────────────
# Default env. Non-secret defaults only — secrets MUST be supplied at
# `docker run -e ...` time, never baked into the image.
#
# Required at runtime (read by main.ts; missing any → exit code 2):
#   MAJOR_API_BASE_URL          — Supabase functions root (no trailing slash)
#   SHELL_ID                    — must be unique per running container; orchestrator
#                                  uses this as the row id in the Shell table
#                                  (`major.shells`)
#   GITHUB_TOKEN                — for `gh` CLI auth (PR create, status checks)
#   SUPABASE_SERVICE_ROLE_KEY   — bearer for Major API calls; auth.ts service-role
#                                  bypass requires X-Major-Shell-Id (sent by main.ts)
#   CLAUDE_CODE_OAUTH_TOKEN     — Max subscription token (preferred), OR
#   ANTHROPIC_API_KEY           — API key fallback. Set at least one.
# Optional:
#   IMAGE_TAG           — recorded in the Shell row's metadata for provenance
#
# We deliberately do NOT set NODE_ENV. Setting it to "production" globally
# makes sandbox `npm install` calls skip devDependencies, which silently
# breaks every test-writing Brief (e.g. Brief 15 hit max_turns trying to
# diagnose why jest-expo wasn't installing despite being in package.json).
# The Shell daemon is a plain TypeScript process with no NODE_ENV-sensitive
# code path; leaving NODE_ENV unset lets sandbox npm calls install dev
# deps as expected.
# ────────────────────────────────────────────────────────────────────
ENV MAJOR_API_BASE_URL="https://nuihvxluxdpdjgkvtdih.supabase.co/functions/v1"

# Drop privileges for the daemon process. Container is the security boundary;
# inside the container, agent UID matters less, but defense-in-depth.
USER agent

# Compiled output lives at /opt/major-shell/dist/main.js (see tsconfig).
ENTRYPOINT ["node", "/opt/major-shell/dist/main.js"]
