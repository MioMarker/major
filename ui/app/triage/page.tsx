import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listTriageSessions } from "@/lib/api/triage";
import { getServerAuthToken } from "@/lib/auth-server";
import { formatRelativeAge } from "@/lib/utils";
import type { GithubIssueTrigger, TriageSession } from "@/lib/types";
import { AutoTriageButton } from "./_auto-triage-button";
import { NewTriageSessionButton } from "./_new-session-button";
import { PullFromReposButton } from "./_pull-from-repos-button";
import { DeleteSessionButton } from "./_delete-session-button";
import { TriageSelectionProvider } from "./_selection";
import { SelectAllCheckbox } from "./_select-all-checkbox";
import { RowCheckbox } from "./_row-checkbox";
import { BulkDeleteBar } from "./_bulk-delete-bar";

function isGithubTrigger(payload: TriageSession["trigger_payload"]): payload is GithubIssueTrigger {
  return payload !== null && typeof payload === "object" && "source_issue_title" in payload;
}

function getSessionTitle(session: TriageSession): string {
  if (isGithubTrigger(session.trigger_payload)) {
    return session.trigger_payload.source_issue_title;
  }
  if (session.draft_prd) {
    const match = session.draft_prd.match(/^#\s+(.+)/m);
    if (match) return match[1];
  }
  return `Session #${session.id}`;
}

export default async function TriageListPage() {
  const authToken = await getServerAuthToken();
  const sessions = await listTriageSessions(authToken ?? undefined);

  const selectableIds = sessions.map((session) => session.id);

  return (
    <AppShell active="/triage">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
          <p className="text-sm text-muted-foreground">
            Durable, resumable conversations that propose Triage Change Sets.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AutoTriageButton />
          <PullFromReposButton />
          <NewTriageSessionButton />
        </div>
      </div>
      <TriageSelectionProvider selectableIds={selectableIds}>
        <BulkDeleteBar />
        <div className="mt-4 rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <SelectAllCheckbox />
                </TableHead>
                <TableHead>Issue</TableHead>
                <TableHead className="w-[220px]">Repo</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead className="w-[140px]">Last activity</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const trigger = isGithubTrigger(session.trigger_payload)
                  ? session.trigger_payload
                  : null;
                return (
                  <TableRow key={session.id} className="group">
                    <TableCell className="w-10">
                      <RowCheckbox sessionId={session.id} />
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/triage/${session.id}`}
                        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {getSessionTitle(session)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {trigger ? trigger.source_issue_repo : "—"}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        session.status === "open"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {session.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelativeAge(session.updated_at)} ago
                    </TableCell>
                    <TableCell className="text-right">
                      <DeleteSessionButton sessionId={session.id} />
                    </TableCell>
                  </TableRow>
                );
              })}
              {sessions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No triage sessions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </TriageSelectionProvider>
    </AppShell>
  );
}
