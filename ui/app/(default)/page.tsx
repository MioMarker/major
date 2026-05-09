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
import { listItems } from "@/lib/api/items";
import { formatRelativeAge } from "@/lib/utils";
import type {
  WorkItemClassification,
  WorkItemStatus,
} from "@/lib/types";
import { ItemsFilters } from "./_filters";

interface PageProps {
  searchParams: { status?: string; classification?: string };
}

const STATUS_VALUES: WorkItemStatus[] = [
  "ready-for-triage",
  "needs-info",
  "ready-for-agent",
  "agent-running",
  "ready-for-review",
  "ready-for-human",
  "done",
  "wontfix",
];

const CLASSIFICATIONS: WorkItemClassification[] = [
  "bug-fix",
  "feature",
  "refactor",
  "docs",
  "parent",
  "epic",
];

export default async function ItemsViewPage({ searchParams }: PageProps) {
  const status = STATUS_VALUES.includes(searchParams.status as WorkItemStatus)
    ? (searchParams.status as WorkItemStatus)
    : undefined;
  const classification = CLASSIFICATIONS.includes(
    searchParams.classification as WorkItemClassification,
  )
    ? (searchParams.classification as WorkItemClassification)
    : undefined;

  const items = await listItems({ status, classification });

  return (
    <AppShell active="/">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Items</h1>
          <p className="text-sm text-muted-foreground">
            Filter by status / classification, sorted by queue rank.
          </p>
        </div>
      </div>
      <ItemsFilters status={status} classification={classification} />
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
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    href={`/items/${item.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    #{item.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {item.classifications.map((c) => (
                      <Badge key={c} variant="secondary">
                        {c}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground">
                  {item.expected_paths.length === 0
                    ? "—"
                    : item.expected_paths.slice(0, 2).join(", ") +
                      (item.expected_paths.length > 2
                        ? ` (+${item.expected_paths.length - 2})`
                        : "")}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {item.queue_rank ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {formatRelativeAge(item.created_at)}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No items match these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </AppShell>
  );
}
