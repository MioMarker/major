// supabase/functions/major-github-webhook/parse-pr-receipt.ts
//
// Parse the Brief id from a PR body's Repository Correlation Receipt.
//
// The receipt format (per the implementer Tachikoma prompt's footer) is:
//
//     ## Linked
//
//     Major-brief: 42
//     Run: 12345
//
// Parsing is anchored to the `## Linked` section to avoid false positives
// from PRs that mention the receipt format inline (in prose, code blocks,
// runbook examples, etc.). The pre-#52 parser matched anywhere in the body
// and cross-wired PR #51 to Brief 10 (see issue #52 for the incident).
//
// Accepts both `Major-brief:` (current) and `Major-item:` (legacy pre-rename
// PRs) so any old open PRs still correlate.

export function parseBriefIdFromBody(body: string | null | undefined): number | null {
  if (!body) return null;

  // Find the `## Linked` heading. Must be at line start, H2 only — the
  // implementer prompt emits exactly this heading and nothing else uses it.
  const linkedMatch = body.match(/^## Linked\s*$/m);
  if (!linkedMatch || linkedMatch.index === undefined) return null;

  // Slice from after the heading to the next H2 (or end of body) so receipt-
  // shaped content in later sections doesn't bleed in.
  const startIdx = linkedMatch.index + linkedMatch[0].length;
  const remaining = body.slice(startIdx);
  const nextH2 = remaining.match(/^## /m);
  const section = nextH2 && nextH2.index !== undefined
    ? remaining.slice(0, nextH2.index)
    : remaining;

  // Within the Linked section, the receipt must be on its own line.
  // Multiline mode + anchors at line start/end rule out mid-prose mentions.
  const m = section.match(/^Major-(?:brief|item):\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}
