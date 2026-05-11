"use client";

import { Badge } from "@/components/ui/badge";

interface Props {
  prUrl: string;
  prStatus: "open" | "merged";
}

export function PrBadge({ prUrl, prStatus }: Props) {
  return (
    <a
      href={prUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex"
    >
      <Badge
        variant="outline"
        className={
          prStatus === "merged"
            ? "border-purple-300 bg-purple-50 text-purple-700"
            : "border-blue-300 bg-blue-50 text-blue-700"
        }
      >
        {prStatus === "merged" ? "merged ↗" : "PR open ↗"}
      </Badge>
    </a>
  );
}
