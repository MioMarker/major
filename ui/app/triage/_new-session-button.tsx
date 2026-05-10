"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createTriageSession } from "@/lib/api/triage";
import { getSessionToken } from "@/lib/auth";

export function NewTriageSessionButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const authToken = (await getSessionToken()) ?? undefined;
      const session = await createTriageSession("human:jonathan", authToken);
      router.push(`/triage/${session.id}`);
    });
  }

  return (
    <Button onClick={handleClick} disabled={isPending}>
      {isPending ? "Creating…" : "New session"}
    </Button>
  );
}
