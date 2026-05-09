import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listTriageSessions } from "@/lib/api/triage";
import { formatRelativeAge } from "@/lib/utils";
import { NewTriageSessionButton } from "./_new-session-button";

export default async function TriageListPage() {
  const sessions = await listTriageSessions();

  return (
    <AppShell active="/triage">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
          <p className="text-sm text-muted-foreground">
            Durable, resumable conversations that propose Triage Change Sets.
          </p>
        </div>
        <NewTriageSessionButton />
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">ID</TableHead>
              <TableHead>Initiator</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Messages</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.id}>
                <TableCell className="font-mono text-xs">
                  <Link
                    href={`/triage/${session.id}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    #{session.id}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {session.initiator_actor}
                </TableCell>
                <TableCell>
                  <Badge variant={session.status === "open" ? "default" : "secondary"}>
                    {session.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelativeAge(session.updated_at)} ago
                </TableCell>
                <TableCell className="text-xs">
                  {session.transcript.length}
                </TableCell>
              </TableRow>
            ))}
            {sessions.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No triage sessions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </AppShell>
  );
}
