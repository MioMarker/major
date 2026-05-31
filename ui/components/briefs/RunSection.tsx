"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TimelineRun } from "@/lib/timeline";
import type { DispositionTone } from "@/lib/disposition";
import { summarizeTelemetry, telemetryChipText } from "@/lib/telemetry-summary";
import { formatRelativeAge } from "@/lib/utils";
import { cn } from "@/lib/utils";

function toneToVariant(
  tone: DispositionTone,
): "default" | "secondary" | "destructive" | "outline" {
  switch (tone) {
    case "success":
      return "default";
    case "warning":
      return "secondary";
    case "destructive":
      return "destructive";
    case "info":
      return "secondary";
    case "muted":
      return "outline";
  }
}

function formatRunDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "running";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

interface RunSectionProps {
  timelineRun: TimelineRun;
  briefId: number;
  defaultExpanded: boolean;
}

export function RunSection({ timelineRun, briefId, defaultExpanded }: RunSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { run, disposition, verifications, routineTelemetry, exceptionalTelemetry } = timelineRun;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="shrink-0 text-xs text-muted-foreground">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="font-mono text-sm font-semibold">Run #{run.id}</span>
        <Badge variant={toneToVariant(disposition.tone)} className="text-xs">
          {disposition.label}
        </Badge>
        <span className="text-xs text-muted-foreground">{run.purpose}</span>
        <span className="text-xs text-muted-foreground">
          {formatRunDuration(run.started_at, run.ended_at)}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {formatRelativeAge(run.started_at)} ago
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t px-4 pb-4 pt-3">
          {/* Planner scope expansion — paths needed */}
          {disposition.additionalPathsNeeded && disposition.additionalPathsNeeded.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                Paths needed beyond scope:
              </p>
              <div className="flex flex-wrap gap-1">
                {disposition.additionalPathsNeeded.map((p) => (
                  <Badge key={p} variant="outline" className="font-mono text-xs">
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Routine telemetry chip */}
          {routineTelemetry.length > 0 && (
            <div>
              <Link
                href={`/briefs/${briefId}?tab=telemetry`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <span>▸</span>
                <span>{telemetryChipText(routineTelemetry)}</span>
              </Link>
            </div>
          )}

          {/* Exceptional telemetry — always visible */}
          {exceptionalTelemetry.length > 0 && (
            <div className="space-y-1">
              {exceptionalTelemetry.map((rec) => {
                const summary = summarizeTelemetry(rec);
                return (
                  <div
                    key={rec.id}
                    className={cn(
                      "flex items-start gap-2 rounded-sm px-2 py-1 text-xs",
                      summary.tone === "destructive"
                        ? "bg-destructive/10 text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="font-medium shrink-0">{summary.label}</span>
                    <span className="min-w-0 break-all">
                      {summary.lines.join(" · ")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Verification table */}
          {verifications.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {verifications.map((vr) => (
                  <TableRow key={vr.id}>
                    <TableCell className="font-mono text-xs">{vr.check_name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          vr.outcome === "pass"
                            ? "default"
                            : vr.outcome === "fail"
                              ? "destructive"
                              : "secondary"
                        }
                        className="text-xs"
                      >
                        {vr.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{vr.required ? "yes" : "no"}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {vr.requiredness_source ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Footer deep-links */}
          <div className="flex gap-4 text-xs text-muted-foreground">
            <Link
              href={`/briefs/${briefId}?tab=runs`}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              View Runs
            </Link>
            <Link
              href={`/briefs/${briefId}?tab=verification`}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              View Verification
            </Link>
            <Link
              href={`/briefs/${briefId}?tab=telemetry`}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              View Telemetry
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
