"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { rearmBrief, rearmAsRepair } from "@/lib/api/briefs";
import type { RunOutcome } from "@/lib/types";

interface RearmButtonProps {
  briefId: number;
  latestRunOutcome?: RunOutcome;
}

export function RearmButton({ briefId, latestRunOutcome }: RearmButtonProps) {
  const router = useRouter();
  const [rearmOpen, setRearmOpen] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRearm() {
    setError(null);
    startTransition(async () => {
      try {
        await rearmBrief(briefId, reason || undefined);
        setRearmOpen(false);
        setReason("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Re-arm failed");
      }
    });
  }

  function handleRearmAsRepair() {
    setError(null);
    startTransition(async () => {
      try {
        await rearmAsRepair(briefId);
        setRepairOpen(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Re-arm as Repair failed");
      }
    });
  }

  return (
    <div className="flex items-center">
      {/* Primary: Re-arm dialog */}
      <Dialog
        open={rearmOpen}
        onOpenChange={(o) => {
          setRearmOpen(o);
          if (!o) {
            setReason("");
            setError(null);
          }
        }}
      >
        <Button
          variant="default"
          size="sm"
          className="rounded-r-none"
          onClick={() => setRearmOpen(true)}
        >
          Re-arm
        </Button>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-arm brief #{briefId}</DialogTitle>
            <DialogDescription>
              Returns the brief to <code>ready-for-agent</code> so the next idle Shell
              claims it. Records a <code>rearmed</code> Event with your reason. Use when
              the prior failure was an environmental issue you&apos;ve fixed (sandbox change,
              scope expansion, dependency update, etc.) and a fresh Run should now succeed.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="What changed since the last failure? (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRearmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={handleRearm}>
              {isPending ? "Re-arming…" : "Re-arm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secondary: dropdown for "Re-arm as Repair" */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="rounded-l-none border-l-0 px-2"
            aria-label="More re-arm options"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {latestRunOutcome === "failed" ? (
            <DropdownMenuItem onSelect={() => setRepairOpen(true)}>
              Re-arm as Repair
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>
              Re-arm as Repair (requires prior failed run)
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Repair-override confirmation dialog */}
      <Dialog
        open={repairOpen}
        onOpenChange={(o) => {
          setRepairOpen(o);
          if (!o) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-arm as Repair?</DialogTitle>
            <DialogDescription>
              Sets the next claim purpose to <code>repair</code>, routing this brief to the
              repair Tachikoma irrespective of retry budget. Use when the failure requires
              targeted repair, not a fresh execute attempt.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRepairOpen(false)}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={handleRearmAsRepair}>
              {isPending ? "Submitting…" : "Re-arm as Repair"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
