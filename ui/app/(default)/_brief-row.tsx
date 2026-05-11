"use client";

import { useRouter } from "next/navigation";
import { TableRow } from "@/components/ui/table";

interface Props {
  briefId: number;
  children: React.ReactNode;
}

export function BriefRow({ briefId, children }: Props) {
  const router = useRouter();
  return (
    <TableRow
      className="group cursor-pointer hover:bg-muted/50"
      onClick={() => router.push(`/briefs/${briefId}`)}
    >
      {children}
    </TableRow>
  );
}
