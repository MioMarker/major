// functions/_shared/path_blocker.ts
//
// Pure (no I/O) implementation of Major's Path-Blocker rule. Caller fetches
// `major.path_blocker_config` row id=1 and passes it in along with the set
// of `expected_paths` accumulated across the Change Set's create-item /
// transition-work-item ops, plus a count of `set-queue-rank` ops in the same
// set (for the mass-rerank threshold check).
//
// Decision: any `expected_paths` intersection with a protected glob OR a
// rerank-op count above the threshold → `needsHumanApply = true`.

export interface PathBlockerConfig {
  protectedGlobs: string[];
  massRerankThreshold: number;
}

export interface PathBlockerResult {
  needsHumanApply: boolean;
  reasons: string[]; // human-readable; persisted to `triage_change_sets.blocker_reasons`
}

export function checkPathBlocker(
  expectedPaths: string[],
  rerankOpCount: number,
  config: PathBlockerConfig,
): PathBlockerResult {
  const reasons: string[] = [];

  // 1. Path-glob intersection — any expected path matching any protected glob trips it.
  for (const path of expectedPaths) {
    for (const glob of config.protectedGlobs) {
      if (matchesGlob(path, glob)) {
        reasons.push(`path '${path}' matches protected glob '${glob}'`);
      }
    }
  }

  // 2. Mass-rerank threshold — touching > N items' queue_rank tips the set into human apply.
  if (rerankOpCount > config.massRerankThreshold) {
    reasons.push(
      `mass-rerank threshold tripped: ${rerankOpCount} rerank ops > threshold ${config.massRerankThreshold}`,
    );
  }

  return { needsHumanApply: reasons.length > 0, reasons };
}

// Minimal POSIX-flavored glob matcher for the small vocabulary the path
// blocker needs: `**` (any depth), `*` (single segment, no `/`), and `?`
// (single char). Sufficient for the initial protected-glob list:
//
//   supabase/functions/chat-with-ai/**
//   eval/**
//   supabase/migrations/**
//   .claude/rules/**
//   app.config.ts
//
// We compile each glob to a RegExp once and match against the candidate path.
export function matchesGlob(path: string, glob: string): boolean {
  // Exact-match fast path.
  if (!glob.includes("*") && !glob.includes("?")) return path === glob;

  let regex = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const next = glob[i + 1];
    if (c === "*" && next === "*") {
      // `**` — matches across any number of segments.
      regex += ".*";
      i++; // consume the second '*'
      // Eat a trailing '/' so '**/foo' matches 'foo' as well as 'a/foo'.
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      // `*` — matches anything except `/`.
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if ("/.+()|^$[]{}\\".includes(c)) {
      // Escape regex metacharacters we encounter literally.
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  regex += "$";
  return new RegExp(regex).test(path);
}
