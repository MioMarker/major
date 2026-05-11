"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { autoTriageSessions, type AutoTriageSessionResult } from "@/lib/api/triage";
import { getSessionToken } from "@/lib/auth";

function OutcomeChip({ outcome }: { outcome: AutoTriageSessionResult["outcome"] }) {
  if (outcome === "triaged") {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
        triaged
      </span>
    );
  }
  if (outcome === "needs_human_apply") {
    return (
      <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
        needs review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
      failed
    </span>
  );
}

export function AutoTriageButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [results, setResults] = useState<AutoTriageSessionResult[]>([]);
  const [counts, setCounts] = useState({ processed: 0, triaged: 0, needs_human_apply: 0, failed: 0 });
  const [isPending, startTransition] = useTransition();

  function handleRun() {
    setDone(false);
    setResults([]);
    setCounts({ processed: 0, triaged: 0, needs_human_apply: 0, failed: 0 });
    setOpen(true);
    startTransition(async () => {
      const token = await getSessionToken();
      const resp = await autoTriageSessions(token ?? undefined);
      setResults(resp.results);
      setCounts({
        processed: resp.processed,
        triaged: resp.triaged,
        needs_human_apply: resp.needs_human_apply,
        failed: resp.failed,
      });
      setDone(true);
      router.refresh();
    });
  }

  function handleClose() {
    setOpen(false);
  }

  return (
    <>
      <Button variant="outline" onClick={handleRun} disabled={isPending}>
        {isPending
          ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          : <Sparkles className="mr-1.5 h-4 w-4" />}
        {isPending ? "Triaging…" : "Auto-triage"}
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!isPending) setOpen(v); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{done ? "Auto-triage complete" : "Auto-triaging…"}</DialogTitle>
            {!done && (
              <DialogDescription>
                Running triage on open sessions. This may take a minute.
              </DialogDescription>
            )}
          </DialogHeader>

          {!done ? (
            <div className="flex flex-col items-center gap-4 py-10 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm">Analyzing sessions with AI…</p>
            </div>
          ) : (
            <>
              <div className="flex gap-4 text-sm">
                <span className="text-muted-foreground">
                  <span className="font-medium text-foreground">{counts.processed}</span> processed
                </span>
                <span className="text-muted-foreground">
                  <span className="font-medium text-green-700 dark:text-green-400">{counts.triaged}</span> triaged
                </span>
                {counts.needs_human_apply > 0 && (
                  <span className="text-muted-foreground">
                    <span className="font-medium text-yellow-700 dark:text-yellow-400">{counts.needs_human_apply}</span> need review
                  </span>
                )}
                {counts.failed > 0 && (
                  <span className="text-muted-foreground">
                    <span className="font-medium text-red-700 dark:text-red-400">{counts.failed}</span> failed
                  </span>
                )}
              </div>

              {results.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No open sessions to triage.
                </p>
              )}

              {results.length > 0 && (
                <div className="max-h-[50vh] overflow-y-auto rounded-lg border divide-y">
                  {results.map((r) => (
                    <div key={r.sessionId} className="px-4 py-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{r.title}</p>
                        <OutcomeChip outcome={r.outcome} />
                      </div>
                      <p className="text-xs text-muted-foreground">{r.summary}</p>
                      {r.error && (
                        <p className="text-xs text-destructive">{r.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={handleClose}>Done</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
