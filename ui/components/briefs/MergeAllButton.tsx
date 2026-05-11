"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MergeAllPanel } from "@/components/briefs/MergeAllPanel";

interface Props {
  // Count of Briefs whose status is in {`ready-for-review`, `merge-blocked`},
  // pre-fetched server-side. Used purely to enable/disable the button — the
  // panel itself re-queries at open time, so a stale count just disables the
  // button until the next page render. A zero count disables it; the panel
  // never opens with nothing to merge.
  eligibleCount: number;
}

export function MergeAllButton({ eligibleCount }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const disabled = eligibleCount === 0;
  const tooltip = disabled
    ? "No Briefs are ready for review or merge-blocked."
    : `Merge ${eligibleCount} ready-for-review or merge-blocked brief${eligibleCount !== 1 ? "s" : ""}.`;

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={tooltip}
        aria-label={tooltip}
      >
        <GitMerge className="mr-2 h-4 w-4" />
        Merge all ready-for-review
        {eligibleCount > 0 && (
          <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium">
            {eligibleCount}
          </span>
        )}
      </Button>
      <MergeAllPanel
        open={open}
        onOpenChange={setOpen}
        onRunFinished={(state) => {
          if (state.merged.length > 0) router.refresh();
        }}
      />
    </>
  );
}
