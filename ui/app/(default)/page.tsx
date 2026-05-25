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
import { listBriefsEligibleForMerge, listBriefsPaged } from "@/lib/api/briefs";
import { getServerAuthToken } from "@/lib/auth-server";
import { formatRelativeAge } from "@/lib/utils";
import type {
  BriefClassification,
  BriefStatus,
} from "@/lib/types";
import { MergeAllButton } from "@/components/briefs/MergeAllButton";
import { BriefsFilters } from "./_filters";
import { BriefsPagination } from "./_pagination";
import { QuickStartButton } from "./_quick-start-button";
import { DeleteBriefButton } from "./_delete-brief-button";
import { BriefRow } from "./_brief-row";
import { PrBadge } from "./_pr-badge";
import { BriefSelectionProvider } from "./_selection";
import { SelectAllCheckbox } from "./_select-all-checkbox";
import { RowCheckbox } from "./_row-checkbox";
import { BulkDeleteBar } from "./_bulk-delete-bar";

interface PageProps {
  searchParams: { status?: string; classification?: string; page?: string };
}

// One page worth of Briefs. The endpoint caps at 200; 50 keeps the table
// readable while real Prev/Next paging makes every Brief reachable.
const BRIEFS_PER_PAGE = 50;

const STATUS_VALUES: BriefStatus[] = [
  "ready-for-triage",
  "needs-info",
  "ready-for-agent",
  "agent-running",
  "ready-for-review",
  "ready-for-human",
  "merge-blocked",
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

const PRIORITY_TONE: Record<string, string> = {
  p0: "border-red-300 bg-red-50 text-red-700",
  p1: "border-orange-300 bg-orange-50 text-orange-700",
  p2: "border-yellow-300 bg-yellow-50 text-yellow-700",
};

export default async function BriefsViewPage({ searchParams }: PageProps) {
  const status = STATUS_VALUES.includes(searchParams.status as BriefStatus)
    ? (searchParams.status as BriefStatus)
    : undefined;
  const classification = CLASSIFICATIONS.includes(
    searchParams.classification as BriefClassification,
  )
    ? (searchParams.classification as BriefClassification)
    : undefined;

  const parsedPage = Number(searchParams.page);
  const page =
    Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const offset = (page - 1) * BRIEFS_PER_PAGE;

  const authToken = await getServerAuthToken();
  const [{ briefs, total }, eligibleForMerge] = await Promise.all([
    listBriefsPaged(
      { status, classification, authToken: authToken ?? undefined },
      { limit: BRIEFS_PER_PAGE, offset },
    ),
    listBriefsEligibleForMerge(authToken ?? undefined),
  ]);

  // agent-running Briefs can't be deleted (mirrors the single-delete guard), so
  // they're excluded from selection / select-all.
  const selectableIds = briefs
    .filter((brief) => brief.status !== "agent-running")
    .map((brief) => brief.id);

  return (
    <AppShell active="/">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Briefs</h1>
          <p className="text-sm text-muted-foreground">
            {total === 0
              ? "No briefs yet."
              : `${total} brief${total !== 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MergeAllButton eligibleCount={eligibleForMerge.length} />
          <QuickStartButton />
        </div>
      </div>
      <BriefsFilters status={status} classification={classification} />
      <BriefSelectionProvider selectableIds={selectableIds}>
      <BulkDeleteBar />
      <div className="mt-4 rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <SelectAllCheckbox />
              </TableHead>
              <TableHead>Brief</TableHead>
              <TableHead className="w-[160px]">Status</TableHead>
              <TableHead className="w-[160px]">Classifications</TableHead>
              <TableHead className="w-[100px]">PR</TableHead>
              <TableHead className="w-[80px]">Rank</TableHead>
              <TableHead className="w-[64px]">Age</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {briefs.map((brief) => (
              <BriefRow key={brief.id} briefId={brief.id}>
                {/* Select */}
                <TableCell className="w-10">
                  <RowCheckbox
                    briefId={brief.id}
                    disabled={brief.status === "agent-running"}
                  />
                </TableCell>

                {/* Brief — title + meta */}
                <TableCell>
                  <div className="font-medium leading-snug">
                    {brief.title ?? (
                      <span className="text-muted-foreground italic">Untitled</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{brief.id}
                    </span>
                    {brief.git_repository_ref && (
                      <span className="text-xs text-muted-foreground">
                        {brief.git_repository_ref.split("/")[1]}
                      </span>
                    )}
                    {brief.placement_reason && (
                      <span className="text-xs text-muted-foreground">
                        · {brief.placement_reason}
                      </span>
                    )}
                  </div>
                </TableCell>

                {/* Status */}
                <TableCell>
                  <StatusBadge status={brief.status} />
                </TableCell>

                {/* Classifications */}
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {brief.classifications.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      brief.classifications.map((c) => (
                        <Badge key={c} variant="secondary">
                          {c}
                        </Badge>
                      ))
                    )}
                  </div>
                </TableCell>

                {/* PR */}
                <TableCell>
                  {(brief.pr_status === "open" || brief.pr_status === "merged") &&
                  brief.pr_url ? (
                    <PrBadge prUrl={brief.pr_url} prStatus={brief.pr_status} />
                  ) : null}
                </TableCell>

                {/* Rank + priority */}
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs">
                      {brief.queue_rank ?? "—"}
                    </span>
                    {brief.priority_class && (
                      <Badge
                        variant="outline"
                        className={`py-0 px-1 text-xs ${PRIORITY_TONE[brief.priority_class] ?? "border-slate-300 bg-slate-50 text-slate-700"}`}
                      >
                        {brief.priority_class}
                      </Badge>
                    )}
                  </div>
                </TableCell>

                {/* Age */}
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {formatRelativeAge(brief.created_at)}
                </TableCell>

                {/* Actions */}
                <TableCell className="text-right">
                  <DeleteBriefButton
                    briefId={brief.id}
                    disabled={brief.status === "agent-running"}
                  />
                </TableCell>
              </BriefRow>
            ))}
            {briefs.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center">
                  <p className="text-muted-foreground">No briefs match these filters.</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    <Link
                      href="/triage"
                      className="underline underline-offset-4 hover:text-foreground"
                    >
                      Start a Triage Session
                    </Link>{" "}
                    to create Briefs, or clear a filter above.
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      </BriefSelectionProvider>
      {total > 0 && (
        <BriefsPagination
          page={page}
          perPage={BRIEFS_PER_PAGE}
          total={total}
          status={status}
          classification={classification}
        />
      )}
    </AppShell>
  );
}
