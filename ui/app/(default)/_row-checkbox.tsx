"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useBriefSelection } from "./_selection";

interface Props {
  briefId: number;
  disabled?: boolean;
}

export function RowCheckbox({ briefId, disabled }: Props) {
  const { isSelected, toggle } = useBriefSelection();
  return (
    <Checkbox
      checked={isSelected(briefId)}
      onCheckedChange={() => toggle(briefId)}
      disabled={disabled}
      // Stop the click from bubbling to BriefRow's row-navigation handler.
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select brief #${briefId}`}
    />
  );
}
