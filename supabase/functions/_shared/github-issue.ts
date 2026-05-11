// supabase/functions/_shared/github-issue.ts
//
// Implements ADR 011: outbound Brief → source GitHub issue resolution comment.
//
// Called from three trigger points when a Brief reaches a terminal state:
//   1. major-github-webhook  (PR closed → done | wontfix)
//   2. major-confirm-qa      (human QA confirm → done)
//   3. major-reject-brief    (human reject → wontfix)
//
// The helper renders the comment body per the ADR template, posts it to the
// source issue, then PATCHes the issue closed. Idempotent: scans existing
// comments for the marker `Resolved by Major Brief #<id>` and skips the POST
// if found (but still PATCHes, since the issue may have been reopened or the
// previous attempt may have crashed between POST and PATCH).
//
// Authenticates via the GITHUB_APP_TOKEN env var (same fine-grained PAT
// ADR 007 uses; needs `Issues: Write`). The author login is rendered into the
// comment for transparency; it is looked up via GET /user.
//
// Failures are returned as { ok: false, error } and never thrown. Callers are
// expected to log a Telemetry Record on ok:false; lifecycle transitions are
// NOT blocked by comment-post failures (same posture as ADR 007 §18).
//
// MARKER WARNING: the duplicate-detection text is `Resolved by Major Brief
// #<id>`. If you change the comment template, keep the marker line stable
// or you break idempotency across the version drift window.

const GITHUB_API = "https://api.github.com";
const COMMENT_MARKER_PREFIX = "Resolved by Major Brief #";
const COMMENTS_PAGE_SIZE = 100;
const COMMENTS_PAGE_CAP = 5;

// Focused subset of major.verification_results columns the comment needs.
// Snake_case to match PostgREST-row shape that callers typically pass through.
export type ResolutionVerification = {
  check_name: string;
  outcome: string;
  required: boolean;
};

export type PostResolutionArgs = {
  issueRepo: string; // "owner/repo"
  issueNumber: number;
  brief: {
    id: number;
    title: string;
    pr_url: string | null;
    status: "done" | "wontfix";
  };
  verificationResults: ResolutionVerification[];
  closeReason: "completed" | "not_planned";
  rejectionReason?: string | null;
};

export type PostResolutionResult = { ok: boolean; error?: string };

// Internal dependency seam. Production defaults read real env and real fetch;
// tests swap via `__testing.setDeps`. The seam exists because edge-function
// env access requires `--allow-env`, which the iteration's bare `deno test`
// invocation does not grant; the same trick lets us avoid `--allow-net`.
type Deps = {
  env: (key: string) => string | undefined;
  fetch: typeof fetch;
};

const _deps: Deps = {
  env: (key) => Deno.env.get(key),
  fetch: (input, init) => fetch(input, init),
};

export const __testing = {
  setDeps(overrides: Partial<Deps>): void {
    if (overrides.env) _deps.env = overrides.env;
    if (overrides.fetch) _deps.fetch = overrides.fetch;
  },
  resetDeps(): void {
    _deps.env = (key) => Deno.env.get(key);
    _deps.fetch = (input, init) => fetch(input, init);
  },
};

export async function postResolutionAndClose(
  args: PostResolutionArgs,
): Promise<PostResolutionResult> {
  const token = _deps.env("GITHUB_APP_TOKEN");
  if (!token) {
    return { ok: false, error: "GITHUB_APP_TOKEN not configured" };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // ─── Idempotency scan ───────────────────────────────────────────
  const markerScan = await findExistingMarkerComment(
    args.issueRepo,
    args.issueNumber,
    args.brief.id,
    headers,
  );
  if (!markerScan.ok) return { ok: false, error: markerScan.error };

  // ─── POST the comment if no marker found ────────────────────────
  if (!markerScan.found) {
    const botLogin = await fetchBotLogin(headers);
    if (!botLogin.ok) return { ok: false, error: botLogin.error };

    const body = renderResolutionComment({
      brief: args.brief,
      verificationResults: args.verificationResults,
      rejectionReason: args.rejectionReason ?? null,
      botLogin: botLogin.login,
    });

    const postRes = await _deps.fetch(
      `${GITHUB_API}/repos/${args.issueRepo}/issues/${args.issueNumber}/comments`,
      { method: "POST", headers, body: JSON.stringify({ body }) },
    );
    if (!postRes.ok) {
      const detail = await safeText(postRes);
      return {
        ok: false,
        error: `comment POST failed: ${postRes.status} ${detail}`,
      };
    }
  }

  // ─── PATCH the issue closed (always, even on idempotent skip) ────
  const closeRes = await _deps.fetch(
    `${GITHUB_API}/repos/${args.issueRepo}/issues/${args.issueNumber}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        state: "closed",
        state_reason: args.closeReason,
      }),
    },
  );
  if (!closeRes.ok) {
    const detail = await safeText(closeRes);
    return {
      ok: false,
      error: `issue PATCH failed: ${closeRes.status} ${detail}`,
    };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Body rendering
// ─────────────────────────────────────────────────────────────────

function renderResolutionComment(args: {
  brief: {
    id: number;
    title: string;
    pr_url: string | null;
    status: "done" | "wontfix";
  };
  verificationResults: ResolutionVerification[];
  rejectionReason: string | null;
  botLogin: string;
}): string {
  const { brief, verificationResults, rejectionReason, botLogin } = args;
  const sections: string[] = [];

  sections.push(
    `${COMMENT_MARKER_PREFIX}${brief.id} — **${brief.status}**`,
  );
  sections.push(`> ${brief.title}`);

  if (brief.pr_url) {
    const parsed = parsePrUrl(brief.pr_url);
    const linkText = parsed
      ? `${parsed.owner}/${parsed.repo}#${parsed.number}`
      : brief.pr_url;
    sections.push(`**Pull Request:** [${linkText}](${brief.pr_url})`);
  }

  if (verificationResults.length > 0) {
    const sorted = sortVerifications(verificationResults);
    const lines = sorted.map(
      (v) =>
        `- ${v.check_name}: ${v.outcome} (required: ${v.required ? "yes" : "no"})`,
    );
    sections.push(["**Verification:**", ...lines].join("\n"));
  }

  if (brief.status === "wontfix" && rejectionReason) {
    sections.push(`**Reason:** ${rejectionReason}`);
  }

  sections.push(`— posted by Major (${botLogin})`);
  return sections.join("\n\n");
}

function sortVerifications(
  v: readonly ResolutionVerification[],
): ResolutionVerification[] {
  // Required first, then advisory; stable within each group.
  const required: ResolutionVerification[] = [];
  const advisory: ResolutionVerification[] = [];
  for (const item of v) {
    (item.required ? required : advisory).push(item);
  }
  return [...required, ...advisory];
}

function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = Number.parseInt(m[3], 10);
  if (!Number.isFinite(num)) return null;
  return { owner: m[1], repo: m[2], number: num };
}

// ─────────────────────────────────────────────────────────────────
// GitHub API helpers
// ─────────────────────────────────────────────────────────────────

async function findExistingMarkerComment(
  repo: string,
  issueNumber: number,
  briefId: number,
  headers: Record<string, string>,
): Promise<{ ok: true; found: boolean } | { ok: false; error: string }> {
  for (let page = 1; page <= COMMENTS_PAGE_CAP; page++) {
    const res = await _deps.fetch(
      `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments?per_page=${COMMENTS_PAGE_SIZE}&page=${page}`,
      { headers },
    );
    if (!res.ok) {
      const detail = await safeText(res);
      return {
        ok: false,
        error: `comments GET failed: ${res.status} ${detail}`,
      };
    }
    const data = await res.json() as Array<{ body?: string | null }>;
    for (const c of data) {
      if (typeof c.body === "string" && commentMatchesMarker(c.body, briefId)) {
        return { ok: true, found: true };
      }
    }
    if (data.length < COMMENTS_PAGE_SIZE) break;
  }
  return { ok: true, found: false };
}

function commentMatchesMarker(body: string, briefId: number): boolean {
  // Use a regex so `#4` doesn't falsely match `#42`. The marker is followed
  // by a non-digit in any rendered comment (space, em-dash, newline).
  const re = /Resolved by Major Brief #(\d+)(?!\d)/g;
  for (const m of body.matchAll(re)) {
    if (m[1] === String(briefId)) return true;
  }
  return false;
}

async function fetchBotLogin(
  headers: Record<string, string>,
): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  // Allow operators to short-circuit the lookup with a static env var; this
  // saves one API call per resolution and is useful when the token's
  // authenticated user is well-known.
  const override = _deps.env("GITHUB_APP_BOT_LOGIN");
  if (override && override.trim().length > 0) {
    return { ok: true, login: override.trim() };
  }
  const res = await _deps.fetch(`${GITHUB_API}/user`, { headers });
  if (!res.ok) {
    const detail = await safeText(res);
    return { ok: false, error: `user GET failed: ${res.status} ${detail}` };
  }
  const data = await res.json() as { login?: unknown };
  if (typeof data.login !== "string" || data.login.length === 0) {
    return { ok: false, error: "user GET returned no login" };
  }
  return { ok: true, login: data.login };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
