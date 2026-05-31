"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteTriageSession } from "@/lib/api/triage";
import { getSessionToken } from "@/lib/auth";
import { useTriageSelection } from "./_selection";

export function BulkDeleteBar() {
  const router = useRouter();
  const { selected, deselect, clear } = useTriageSelection();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const count = selected.size;
  if (count === 0) return null;

  function handleDelete() {
    setError(null);
    const ids = [...selected];
    startTransition(async () => {
      try {
        const token = await getSessionToken();
        const results = await Promise.allSettled(
          ids.map((id) => deleteTriageSession(id, token ?? undefined)),
        );
        const succeeded = ids.filter((_, i) => results[i].status === "fulfilled");
        const failedCount = ids.length - succeeded.length;
        deselect(succeeded);
        router.refresh();
        if (failedCount === 0) {
          setOpen(false);
        } else {
          setError(
            `${failedCount} of ${ids.length} session${ids.length !== 1 ? "s" : ""} could not be deleted. They remain selected.`,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2">
      <span className="text-sm font-medium">
        {count} selected
      </span>
      <Button variant="ghost" size="sm" onClick={clear} disabled={isPending}>
        Clear
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={isPending}
      >
        <Trash2 className="mr-1.5 h-4 w-4" />
        Delete selected
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {count} session{count !== 1 ? "s" : ""}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected triage session{count !== 1 ? "s" : ""} and their change sets. Briefs created from these sessions are kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting…" : `Delete ${count}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
