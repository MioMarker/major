"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  describeMergeFailureReason,
  type MergeAttemptFailedReason,
  mergePr,
} from "@/lib/api/merge-pr";
import { listBriefsEligibleForMerge } from "@/lib/api/briefs";
import { getSessionToken } from "@/lib/auth";
import { runMergeAll } from "@/lib/mode1/algorithm";
import { TIER_LABELS, type MergeRunState, type SkipReason } from "@/lib/mode1/types";
import type { Brief } from "@/lib/types";
import { cn } from "@/lib/utils";

type Phase = "loading" | "ready" | "running" | "complete" | "error";

const STATIC_SKIP_LABELS: Record<Exclude<SkipReason, MergeAttemptFailedReason>, string> = {
  "repo-suspended": "Skipped — repository circuit breaker tripped.",
  "run-cancelled": "Skipped — run cancelled by operator.",
};

function describeSkip(reason: SkipReason, detail: string | null): string {
  if (reason === "repo-suspended" || reason === "run-cancelled") {
    return STATIC_SKIP_LABELS[reason];
  }
  const base = describeMergeFailureReason(reason);
  return detail ? `${base} (${detail})` : base;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called when the panel closes after at least one merge has succeeded, so
  // the parent server-rendered page can refresh the Briefs list.
  onRunFinished?: (state: MergeRunState) => void;
}

export function MergeAllPanel({ open, onOpenChange, onRunFinished }: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<ReadonlyArray<Brief>>([]);
  const [state, setState] = useState<MergeRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const runFiredRef = useRef(false);

  const reset = useCallback(() => {
    setPhase("loading");
    setSnapshot([]);
    setState(null);
    setError(null);
    cancelRef.current = false;
    runFiredRef.current = false;
  }, []);

  // Snapshot Briefs at open time. The list is frozen for the duration of the
  // run — closing the panel and re-opening fetches afresh, but a single run
  // never re-queries the Cyberbrain.
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    let abandoned = false;
    (async () => {
      try {
        const token = await getSessionToken();
        const briefs = await listBriefsEligibleForMerge(token ?? undefined);
        if (abandoned) return;
        setSnapshot(briefs);
        setPhase("ready");
      } catch (err) {
        if (abandoned) return;
        setError(err instanceof Error ? err.message : "Failed to load Briefs.");
        setPhase("error");
      }
    })();
    return () => {
      abandoned = true;
    };
  }, [open, reset]);

  function handleStart() {
    if (runFiredRef.current) return;
    runFiredRef.current = true;
    setPhase("running");
    cancelRef.current = false;
    (async () => {
      const finalState = await runMergeAll({
        briefs: snapshot,
        isCancelled: () => cancelRef.current,
        merge: async (briefId) => {
          const token = await getSessionToken();
          return mergePr(briefId, token ?? undefined);
        },
        onProgress: setState,
      });
      setPhase("complete");
      onRunFinished?.(finalState);
    })();
  }

  function handleStop() {
    cancelRef.current = true;
  }

  function handleClose() {
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block accidental close (e.g. backdrop click) mid-run. Stop must be
        // pressed first; the in-flight call is allowed to complete.
        if (!next && phase === "running") return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge all ready-for-review</DialogTitle>
          <DialogDescription>
            Sequential per-PR approve + squash-merge. Tier-sorted (docs first,
            features last). Per-repo circuit-breaker stops a repo after 3
            consecutive failures.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading eligible Briefs…
          </div>
        )}

        {phase === "error" && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {phase === "ready" && (
          <ReadyView snapshot={snapshot} />
        )}

        {(phase === "running" || phase === "complete") && state && (
          <RunView state={state} phase={phase} />
        )}

        <DialogFooter>
          {phase === "ready" && (
            <>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleStart} disabled={snapshot.length === 0}>
                Start merging {snapshot.length} brief{snapshot.length !== 1 ? "s" : ""}
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button variant="destructive" onClick={handleStop}>
              Stop after current PR
            </Button>
          )}
          {phase === "complete" && (
            <Button onClick={handleClose}>Close</Button>
          )}
          {phase === "error" && (
            <Button variant="ghost" onClick={handleClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReadyView({ snapshot }: { snapshot: ReadonlyArray<Brief> }) {
  if (snapshot.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Briefs are currently eligible for merging.
      </p>
    );
  }
  const repos = Array.from(
    new Set(snapshot.map((b) => b.git_repository_ref ?? "unknown")),
  );
  return (
    <div className="space-y-2 text-sm">
      <p>
        <strong>{snapshot.length}</strong> brief
        {snapshot.length !== 1 ? "s" : ""} eligible across {repos.length} repo
        {repos.length !== 1 ? "s" : ""}.
      </p>
      <p className="text-xs text-muted-foreground">
        Statuses included: <code>ready-for-review</code> and{" "}
        <code>merge-blocked</code>.
      </p>
    </div>
  );
}

function RunView({
  state,
  phase,
}: {
  state: MergeRunState;
  phase: Phase;
}) {
  const processed = state.merged.length + state.skipped.length;
  const current = state.currentBriefId !== null
    ? state.queue.find((q) => q.brief.id === state.currentBriefId)
    : null;

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border bg-muted/30 p-3">
        {phase === "running" && current && (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span>
              Merging <strong>{processed + 1}</strong> of {state.total}: PR
              {current.prNumber ? ` #${current.prNumber}` : ""} (Brief #
              {current.brief.id})
            </span>
          </div>
        )}
        {phase === "complete" && (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>
              Run {state.cancelled ? "stopped" : "complete"} — processed{" "}
              {processed} of {state.total}.
            </span>
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Merged: <strong>{state.merged.length}</strong></span>
          <span>Skipped: <strong>{state.skipped.length}</strong></span>
          {state.suspendedRepos.length > 0 && (
            <span className="flex items-center gap-1 text-amber-700">
              <ShieldAlert className="h-3 w-3" />
              {state.suspendedRepos.length} repo
              {state.suspendedRepos.length !== 1 ? "s" : ""} suspended
            </span>
          )}
        </div>
      </div>

      {state.suspendedRepos.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">Circuit breaker tripped for:</p>
          <ul className="mt-1 list-disc pl-4">
            {state.suspendedRepos.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(state.merged.length > 0 || state.skipped.length > 0) && (
        <ScrollArea className="h-56 rounded-md border">
          <div className="divide-y">
            {state.merged.map((m) => (
              <div key={`m-${m.briefId}`} className="flex items-center gap-2 p-2 text-xs">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="truncate">
                  Brief #{m.briefId} — {m.briefTitle ?? "Untitled"}
                </span>
                <a
                  href={m.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-emerald-700 hover:underline"
                >
                  PR <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            ))}
            {state.skipped.map((s) => (
              <div
                key={`s-${s.briefId}-${s.reason}`}
                className={cn(
                  "flex items-start gap-2 p-2 text-xs",
                  s.reason === "repo-suspended" || s.reason === "run-cancelled"
                    ? "text-muted-foreground"
                    : "text-amber-900",
                )}
              >
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    Brief #{s.briefId} — {s.briefTitle ?? "Untitled"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {describeSkip(s.reason, s.detail)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {phase === "complete" && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Show tier distribution
          </summary>
          <ul className="mt-1 list-disc pl-4">
            {[1, 2, 3, 4].map((tier) => {
              const count = state.queue.filter((q) => q.tier === tier).length;
              if (count === 0) return null;
              return (
                <li key={tier}>
                  Tier {tier} ({TIER_LABELS[tier as 1 | 2 | 3 | 4]}):{" "}
                  <strong>{count}</strong>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
