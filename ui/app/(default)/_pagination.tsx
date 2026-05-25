import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { BriefClassification, BriefStatus } from "@/lib/types";

interface Props {
  page: number;
  perPage: number;
  total: number;
  status?: BriefStatus;
  classification?: BriefClassification;
}

// Builds an "/?..." href for a target page, preserving the active filters so
// paging composes with status/classification. Filters are dropped (and paging
// resets to page 1) by the filter control itself, which rebuilds the query
// string from scratch — see `_filters.tsx`.
function hrefForPage(
  page: number,
  status: BriefStatus | undefined,
  classification: BriefClassification | undefined,
): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (classification) params.set("classification", classification);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export function BriefsPagination({
  page,
  perPage,
  total,
  status,
  classification,
}: Props) {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const hasPrev = page > 1;
  const hasNext = page < pageCount;
  const rangeStart = total === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = Math.min(page * perPage, total);

  return (
    <div className="mt-4 flex items-center justify-between">
      <p className="text-sm text-muted-foreground">
        {total === 0
          ? "Showing 0 of 0"
          : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          Page {Math.min(page, pageCount)} of {pageCount}
        </span>
        <Button
          asChild={hasPrev}
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          aria-disabled={!hasPrev}
        >
          {hasPrev ? (
            <Link href={hrefForPage(page - 1, status, classification)}>
              Previous
            </Link>
          ) : (
            <span>Previous</span>
          )}
        </Button>
        <Button
          asChild={hasNext}
          variant="outline"
          size="sm"
          disabled={!hasNext}
          aria-disabled={!hasNext}
        >
          {hasNext ? (
            <Link href={hrefForPage(page + 1, status, classification)}>
              Next
            </Link>
          ) : (
            <span>Next</span>
          )}
        </Button>
      </div>
    </div>
  );
}
