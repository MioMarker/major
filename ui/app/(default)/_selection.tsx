"use client";

import * as React from "react";

// Multi-select state for the Briefs View, shared between the header
// "select all" checkbox, the per-row checkboxes, and the bulk-delete bar.
// `selectableIds` is the set of Briefs the user is allowed to select on the
// current page (agent-running Briefs are excluded upstream).
interface BriefSelectionContextValue {
  selectableIds: readonly number[];
  selected: ReadonlySet<number>;
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  deselect: (ids: readonly number[]) => void;
  clear: () => void;
  selectAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
}

const BriefSelectionContext =
  React.createContext<BriefSelectionContextValue | null>(null);

export function useBriefSelection(): BriefSelectionContextValue {
  const ctx = React.useContext(BriefSelectionContext);
  if (!ctx) {
    throw new Error(
      "useBriefSelection must be used within a BriefSelectionProvider",
    );
  }
  return ctx;
}

export function BriefSelectionProvider({
  selectableIds,
  children,
}: {
  selectableIds: readonly number[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

  // When the visible page changes (filter, paging, post-delete refresh), drop any
  // selected ids that are no longer selectable so a stale selection can't act on
  // Briefs that left the view.
  const selectableKey = selectableIds.join(",");
  React.useEffect(() => {
    const allowed = new Set(selectableIds);
    setSelected((prev) => {
      const next = new Set<number>();
      for (const id of prev) if (allowed.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // selectableKey is the stable identity of selectableIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectableKey]);

  const toggle = React.useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const deselect = React.useCallback((ids: readonly number[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const clear = React.useCallback(() => setSelected(new Set<number>()), []);

  const selectAll = React.useCallback(
    () => setSelected(new Set(selectableIds)),
    [selectableKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const isSelected = React.useCallback(
    (id: number) => selected.has(id),
    [selected],
  );

  const allSelected =
    selectableIds.length > 0 && selected.size === selectableIds.length;
  const someSelected = selected.size > 0 && !allSelected;

  const value: BriefSelectionContextValue = {
    selectableIds,
    selected,
    isSelected,
    toggle,
    deselect,
    clear,
    selectAll,
    allSelected,
    someSelected,
  };

  return (
    <BriefSelectionContext.Provider value={value}>
      {children}
    </BriefSelectionContext.Provider>
  );
}
