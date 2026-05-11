import { Badge } from "@/components/ui/badge";
import type { BriefStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<BriefStatus, string> = {
  "ready-for-triage": "bg-slate-200 text-slate-900",
  "needs-info": "bg-amber-200 text-amber-900",
  "ready-for-agent": "bg-sky-200 text-sky-900",
  "agent-running": "bg-violet-200 text-violet-900",
  "ready-for-review": "bg-blue-200 text-blue-900",
  "ready-for-human": "bg-rose-200 text-rose-900",
  // ADR 016: merge-blocked — distinct amber tint with a darker outline so the
  // operator-visible "this Brief failed an automated merge" state stands out
  // from `needs-info` (also amber-tinted but lighter, no border emphasis).
  "merge-blocked": "border-amber-500 bg-amber-100 text-amber-900",
  done: "bg-emerald-200 text-emerald-900",
  wontfix: "bg-stone-300 text-stone-700",
};

const STATUS_LABEL: Partial<Record<BriefStatus, string>> = {
  "merge-blocked": "merge blocked",
};

interface Props {
  status: BriefStatus;
  // Most-recent failed-merge reason, surfaced via the badge `title` for
  // hover/focus discovery. Only populated where Event data is in hand
  // (e.g., the Brief Detail view). The Briefs list view leaves it
  // undefined; the badge still renders, just without the tooltip.
  failedMergeReasonLabel?: string;
}

export function StatusBadge({ status, failedMergeReasonLabel }: Props) {
  const label = STATUS_LABEL[status] ?? status;
  const isMergeBlocked = status === "merge-blocked";
  const title = isMergeBlocked && failedMergeReasonLabel
    ? `merge blocked — ${failedMergeReasonLabel}`
    : undefined;
  return (
    <Badge
      variant="outline"
      tabIndex={isMergeBlocked ? 0 : undefined}
      className={cn(
        isMergeBlocked ? "font-medium" : "border-transparent font-medium",
        STATUS_TONE[status],
      )}
      title={title}
      aria-label={title ?? `Status: ${label}`}
    >
      {label}
    </Badge>
  );
}
