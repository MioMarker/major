"use client";

import * as React from "react";

interface TriageSelectionContextValue {
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

const TriageSelectionContext =
  React.createContext<TriageSelectionContextValue | null>(null);

export function useTriageSelection(): TriageSelectionContextValue {
  const ctx = React.useContext(TriageSelectionContext);
  if (!ctx) {
    throw new Error(
      "useTriageSelection must be used within a TriageSelectionProvider",
    );
  }
  return ctx;
}

export function TriageSelectionProvider({
  selectableIds,
  children,
}: {
  selectableIds: readonly number[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

  const selectableKey = selectableIds.join(",");
  React.useEffect(() => {
    const allowed = new Set(selectableIds);
    setSelected((prev) => {
      const next = new Set<number>();
      for (const id of prev) if (allowed.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
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

  const value: TriageSelectionContextValue = {
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
    <TriageSelectionContext.Provider value={value}>
      {children}
    </TriageSelectionContext.Provider>
  );
}
