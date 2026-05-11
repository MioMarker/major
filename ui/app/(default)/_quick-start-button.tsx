"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { quickStart } from "@/lib/api/briefs";
import { getSessionToken } from "@/lib/auth";

export function QuickStartButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ triaged: number; readyForAgent: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      try {
        const token = await getSessionToken();
        const res = await quickStart(token ?? undefined);
        setResult(res);
        setOpen(false);
        setTimeout(() => router.refresh(), 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => { setResult(null); setError(null); setOpen(true); }}>
        Quick Start
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quick Start</DialogTitle>
            <DialogDescription>
              This will auto-triage all ready-for-triage briefs and signal the agent queue. Continue?
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={isPending}>
              {isPending ? "Running…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {result && (
        <p className="text-xs text-muted-foreground">
          Auto-triaged {result.triaged} briefs. {result.readyForAgent} moved to ready-for-agent.
        </p>
      )}
    </>
  );
}
