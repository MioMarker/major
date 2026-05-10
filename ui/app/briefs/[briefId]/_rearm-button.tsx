"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { rearmBrief } from "@/lib/api/briefs";
import { getSessionToken } from "@/lib/auth";

export function RearmBriefButton({ briefId }: { briefId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRearm() {
    setError(null);
    startTransition(async () => {
      try {
        const authToken = (await getSessionToken()) ?? undefined;
        await rearmBrief(briefId, reason || undefined, authToken);
        setOpen(false);
        setReason("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Re-arm failed");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm">
          Re-arm
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-arm brief #{briefId}</DialogTitle>
          <DialogDescription>
            Returns the brief to <code>ready-for-agent</code> so the next idle Shell
            claims it. Records a <code>rearmed</code> Event with your reason. Use when
            the prior failure was an environmental issue you've fixed (sandbox change,
            scope expansion, dependency update, etc.) and a fresh Run should now succeed.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          placeholder="What changed since the last failure? (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
        />
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending}
            onClick={handleRearm}
          >
            {isPending ? "Re-arming…" : "Re-arm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
