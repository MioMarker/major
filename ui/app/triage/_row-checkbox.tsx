"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useTriageSelection } from "./_selection";

interface Props {
  sessionId: number;
}

export function RowCheckbox({ sessionId }: Props) {
  const { isSelected, toggle } = useTriageSelection();
  return (
    <Checkbox
      checked={isSelected(sessionId)}
      onCheckedChange={() => toggle(sessionId)}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select session #${sessionId}`}
    />
  );
}
