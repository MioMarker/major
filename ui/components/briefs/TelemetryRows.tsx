"use client";

import { Fragment, useState } from "react";
import {
  AlertCircle,
  Bot,
  CornerDownRight,
  Info,
  Settings,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { formatRelativeAge } from "@/lib/utils";
import { summarizeTelemetry, type SummaryIcon, type SummaryTone } from "@/lib/telemetry-summary";
import type { Run, TelemetryRecord } from "@/lib/types";

interface Props {
  records: ReadonlyArray<TelemetryRecord>;
  runById: ReadonlyMap<number, Run>;
}

const ICONS: Record<SummaryIcon, typeof Terminal> = {
  bash: Terminal,
  "tool-result": CornerDownRight,
  assistant: Bot,
  system: Settings,
  denied: ShieldAlert,
  error: AlertCircle,
  info: Info,
};

const TONE_LABEL: Record<SummaryTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  info: "text-foreground",
};

const TONE_ICON: Record<SummaryTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  destructive: "text-destructive",
  info: "text-blue-600 dark:text-blue-400",
};

export function TelemetryRows({ records, runById }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (records.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
          No telemetry records yet.
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {records.map((rec) => {
        const run = rec.run_id !== null ? runById.get(rec.run_id) : null;
        const summary = summarizeTelemetry(rec);
        const Icon = ICONS[summary.icon];
        const isOpen = expanded === rec.id;
        return (
          <Fragment key={rec.id}>
            <TableRow
              className="cursor-pointer hover:bg-muted/50"
              data-state={isOpen ? "selected" : undefined}
              onClick={() => setExpanded(isOpen ? null : rec.id)}
            >
              <TableCell className="font-mono text-xs align-top">
                {rec.run_id !== null ? `#${rec.run_id}` : "—"}
                {run && (
                  <span className="ml-1 text-muted-foreground">({run.outcome})</span>
                )}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex items-center gap-2">
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${TONE_ICON[summary.tone]}`} />
                  <span className={`text-xs font-medium ${TONE_LABEL[summary.tone]}`}>
                    {summary.label}
                  </span>
                </div>
              </TableCell>
              <TableCell className="max-w-[640px] align-top">
                <div className="space-y-0.5">
                  {summary.lines.map((line, i) => (
                    <div
                      key={i}
                      className={`truncate font-mono text-xs ${
                        i === 0 ? TONE_LABEL[summary.tone] : "text-muted-foreground"
                      }`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground align-top whitespace-nowrap">
                {formatRelativeAge(rec.created_at)} ago
              </TableCell>
            </TableRow>
            {isOpen && (
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={4} className="py-3">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="outline" className="font-mono">
                        {rec.observation_type}
                      </Badge>
                      <span className="text-muted-foreground">
                        id #{rec.id} · {new Date(rec.created_at).toISOString()}
                      </span>
                      {rec.idempotency_key && (
                        <span className="font-mono text-muted-foreground">
                          idem: {rec.idempotency_key}
                        </span>
                      )}
                    </div>
                    {summary.lines.length > 0 && (
                      <div className="space-y-1">
                        {summary.lines.map((line, i) => (
                          <div key={i} className="font-mono text-xs whitespace-pre-wrap break-all">
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                    <details className="group">
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                        Raw payload
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded border bg-background p-2 font-mono text-xs">
                        {JSON.stringify(rec.payload, null, 2)}
                      </pre>
                    </details>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
