"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { confirmQa } from "@/lib/api/briefs";
import { getSessionToken } from "@/lib/auth";

export function ConfirmQaButton({
  briefId,
  prMerged,
}: {
  briefId: number;
  prMerged: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState(false);

  function handleClick() {
    startTransition(async () => {
      const authToken = (await getSessionToken()) ?? undefined;
      await confirmQa(briefId, authToken);
      setConfirmed(true);
      router.refresh();
    });
  }

  if (confirmed) {
    return (
      <div className="text-xs text-emerald-700">
        QA confirmed. Brief moved to <code>done</code>.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        disabled={isPending || !prMerged}
        onClick={handleClick}
      >
        {isPending ? "Confirming…" : "QA Confirmed"}
      </Button>
      {!prMerged && (
        <p className="text-[11px] text-muted-foreground">
          PR must be merged before QA confirmation moves the brief to done.
        </p>
      )}
    </div>
  );
}
