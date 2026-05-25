"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useBriefSelection } from "./_selection";

export function SelectAllCheckbox() {
  const { allSelected, someSelected, selectAll, clear, selectableIds } =
    useBriefSelection();
  return (
    <Checkbox
      checked={allSelected}
      indeterminate={someSelected}
      disabled={selectableIds.length === 0}
      onCheckedChange={(checked) => (checked ? selectAll() : clear())}
      aria-label={allSelected ? "Deselect all briefs" : "Select all briefs"}
    />
  );
}
