import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listBriefs } from "@/lib/api/briefs";
import { formatRelativeAge } from "@/lib/utils";
import type {
  BriefClassification,
  BriefStatus,
} from "@/lib/types";
import { BriefsFilters } from "./_filters";

interface PageProps {
  searchParams: { status?: string; classification?: string };
}

const STATUS_VALUES: BriefStatus[] = [
  "ready-for-triage",
  "needs-info",
  "ready-for-agent",
  "agent-running",
  "ready-for-review",
  "ready-for-human",
  "done",
  "wontfix",
];

const CLASSIFICATIONS: BriefClassification[] = [
  "bug-fix",
  "feature",
  "refactor",
  "docs",
  "parent",
  "epic",
];

export default async function BriefsViewPage({ searchParams }: PageProps) {
  const status = STATUS_VALUES.includes(searchParams.status as BriefStatus)
    ? (searchParams.status as BriefStatus)
    : undefined;
  const classification = CLASSIFICATIONS.includes(
    searchParams.classification as BriefClassification,
  )
    ? (searchParams.classification as BriefClassification)
    : undefined;

  const briefs = await listBriefs({ status, classification });

  return (
    <AppShell active="/">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Briefs</h1>
          <p className="text-sm text-muted-foreground">
            Filter by status / classification, sorted by queue rank.
          </p>
        </div>
      </div>
      <BriefsFilters status={status} classification={classification} />
      <div className="mt-4 rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Classifications</TableHead>
              <TableHead>Expected paths</TableHead>
              <TableHead className="w-[80px]">Rank</TableHead>
              <TableHead className="w-[80px]">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {briefs.map((brief) => (
              <TableRow key={brief.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    href={`/briefs/${brief.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    #{brief.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={brief.status} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {brief.classifications.map((c) => (
                      <Badge key={c} variant="secondary">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground">
                  {brief.expected_paths.length === 0
                    ? "—"
                    : brief.expected_paths.slice(0, 2).join(", ") +
                      (brief.expected_paths.length > 2
                        ? ` (+${brief.expected_paths.length - 2})`
                        : "")}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {brief.queue_rank ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {formatRelativeAge(brief.created_at)}
                </TableCell>
              </TableRow>
            ))}
            {briefs.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No briefs match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </AppShell>
  );
}
