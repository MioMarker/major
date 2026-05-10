"use client";

import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { Run } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatDuration, formatRelativeAge, formatTokenCount } from "@/lib/utils";

// Renders the stream-events cell for cancelled runs.
// Shows a muted dash matching other empty-metric cells; tooltip reveals the
// actual count plus a note that finalization never ran.
function CancelledStreamEventsCell({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  if (count === 0) {
    return <span className="font-mono">—</span>;
  }

  return (
    <span className="relative inline-block">
      <span
        tabIndex={0}
        aria-describedby={tooltipId}
        className="cursor-help font-mono text-muted-foreground underline decoration-dotted underline-offset-2"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        —
      </span>
      <span
        id={tooltipId}
        role="tooltip"
        className={cn(
          "absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2",
          "w-64 rounded bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md",
          "pointer-events-none",
          open ? "block" : "hidden",
        )}
      >
        {count} stream event{count !== 1 ? "s" : ""} captured before cancellation.
        The other metrics are blank because the Run Finalization Transaction never ran.
      </span>
    </span>
  );
}

interface RunSummaryCardProps {
  run: Run;
}

export function RunSummaryCard({ run }: RunSummaryCardProps) {
  const isCancelled = run.outcome === "cancelled";

  return (
    <div className="rounded-md border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-semibold">#{run.id}</span>
          <Badge
            variant={
              run.outcome === "succeeded"
                ? "default"
                : run.outcome === "running"
                  ? "secondary"
                  : "destructive"
            }
          >
            {run.outcome}
          </Badge>
          <span className="text-xs text-muted-foreground">{run.purpose}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {formatRelativeAge(run.started_at)} ago
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Turns</dt>
          <dd className="font-mono">{run.num_turns ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="font-mono">{formatDuration(run.duration_ms)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Input tok</dt>
          <dd className="font-mono">{formatTokenCount(run.input_tokens)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Output tok</dt>
          <dd className="font-mono">{formatTokenCount(run.output_tokens)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cache read</dt>
          <dd className="font-mono">{formatTokenCount(run.cache_read_tokens)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cache write</dt>
          <dd className="font-mono">{formatTokenCount(run.cache_write_tokens)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Stream events</dt>
          <dd>
            {isCancelled ? (
              <CancelledStreamEventsCell count={run.tachikoma_event_sequence} />
            ) : (
              <span className="font-mono">{run.tachikoma_event_sequence}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Shell</dt>
          <dd className="font-mono">{run.shell_id ?? "—"}</dd>
        </div>
      </dl>
      {run.final_text && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            final_text ({run.final_text.length} chars)
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 font-mono text-xs">
            {run.final_text}
          </pre>
        </details>
      )}
    </div>
  );
}
