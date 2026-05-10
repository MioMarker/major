import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Run, TelemetryRecord } from "@/lib/types";
import { RunSummaryCard } from "./RunSummaryCard";
import { TelemetryRows } from "./TelemetryRows";

const BASH_OBSERVED = "tachikoma-bash-observed";

function topBashCommands(
  records: ReadonlyArray<{ observation_type: string; payload: Record<string, unknown> }>,
  limit = 10,
): Array<{ verb: string; count: number }> {
  const counts = new Map<string, number>();
  for (const rec of records) {
    if (rec.observation_type !== BASH_OBSERVED) continue;
    const cmd = typeof rec.payload.command === "string" ? rec.payload.command : "";
    const verb = cmd.trim().split(/\s+/)[0] ?? "";
    if (!verb) continue;
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([verb, count]) => ({ verb, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

interface TelemetryTabProps {
  runs: Run[];
  telemetryRecords: TelemetryRecord[];
}

export function TelemetryTab({ runs, telemetryRecords }: TelemetryTabProps) {
  const bashTop = topBashCommands(telemetryRecords);
  const runById = new Map(runs.map((r) => [r.id, r]));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Run summaries</CardTitle>
          <CardDescription>
            ADR 006 hoist columns from <code className="font-mono">major.runs</code>.
            Implementer phase only — reviewer-phase metrics live in the Verification
            tab and the rows below (issue #24).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {runs.length === 0 && (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          )}
          {runs.map((run) => (
            <RunSummaryCard key={run.id} run={run} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bash commands (top {bashTop.length || "—"})</CardTitle>
          <CardDescription>
            Top verbs aggregated from <code className="font-mono">{BASH_OBSERVED}</code>{" "}
            records across this Brief&apos;s Runs. Primary signal for ADR 005 Phase 2 deny-list
            calibration.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Verb</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bashTop.map((entry) => (
                <TableRow key={entry.verb}>
                  <TableCell className="font-mono text-xs">{entry.verb}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {entry.count}
                  </TableCell>
                </TableRow>
              ))}
              {bashTop.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="py-8 text-center text-muted-foreground">
                    No bash observations recorded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telemetry records</CardTitle>
          <CardDescription>
            Last {telemetryRecords.length} records from{" "}
            <code className="font-mono">major.telemetry_records</code> (capped at 200,
            newest first).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Run</TableHead>
                <TableHead className="w-40">Type</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-24">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TelemetryRows records={telemetryRecords} runById={runById} />
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
