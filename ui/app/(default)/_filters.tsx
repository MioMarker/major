"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  BriefClassification,
  BriefStatus,
} from "@/lib/types";

const STATUSES: Array<BriefStatus | "all"> = [
  "all",
  "ready-for-triage",
  "needs-info",
  "ready-for-agent",
  "agent-running",
  "ready-for-review",
  "ready-for-human",
  "done",
  "wontfix",
];

const CLASSIFICATIONS: Array<BriefClassification | "all"> = [
  "all",
  "bug-fix",
  "feature",
  "refactor",
  "docs",
  "parent",
  "epic",
];

export function BriefsFilters({
  status,
  classification,
}: {
  status?: BriefStatus;
  classification?: BriefClassification;
}) {
  const router = useRouter();

  function setParam(key: string, value: string | undefined) {
    const params = new URLSearchParams();
    if (status && key !== "status") params.set("status", status);
    if (classification && key !== "classification")
      params.set("classification", classification);
    if (value && value !== "all") params.set(key, value);
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : "/");
  }

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Status: {status ?? "all"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {STATUSES.map((s) => (
            <DropdownMenuItem
              key={s}
              onClick={() => setParam("status", s === "all" ? undefined : s)}
            >
              {s}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Classification: {classification ?? "all"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CLASSIFICATIONS.map((c) => (
            <DropdownMenuItem
              key={c}
              onClick={() =>
                setParam("classification", c === "all" ? undefined : c)
              }
            >
              {c}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {(status || classification) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/")}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
