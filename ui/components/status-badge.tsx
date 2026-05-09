import { Badge } from "@/components/ui/badge";
import type { WorkItemStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<WorkItemStatus, string> = {
  "ready-for-triage": "bg-slate-200 text-slate-900",
  "needs-info": "bg-amber-200 text-amber-900",
  "ready-for-agent": "bg-sky-200 text-sky-900",
  "agent-running": "bg-violet-200 text-violet-900",
  "ready-for-review": "bg-blue-200 text-blue-900",
  "ready-for-human": "bg-rose-200 text-rose-900",
  done: "bg-emerald-200 text-emerald-900",
  wontfix: "bg-stone-300 text-stone-700",
};

export function StatusBadge({ status }: { status: WorkItemStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium", STATUS_TONE[status])}
    >
      {status}
    </Badge>
  );
}
