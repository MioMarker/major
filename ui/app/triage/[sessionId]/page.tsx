import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTriageSession } from "@/lib/api/triage";
import { getServerAuthToken } from "@/lib/auth-server";
import type { GithubIssueTrigger } from "@/lib/types";
import { TriageChat } from "./_chat";

interface PageProps {
  params: { sessionId: string };
}

export default async function TriageSessionPage({ params }: PageProps) {
  const sessionId = Number(params.sessionId);
  if (Number.isNaN(sessionId)) notFound();
  const authToken = await getServerAuthToken();
  const session = await getTriageSession(sessionId, authToken ?? undefined);
  if (!session) notFound();

  return (
    <AppShell active="/triage">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Triage Session #{session.id}
          </h1>
          <p className="text-sm text-muted-foreground">
            Initiated by{" "}
            <span className="font-mono">{session.initiator_actor}</span>
          </p>
        </div>
        <Badge variant={session.status === "open" ? "default" : "secondary"}>
          {session.status}
        </Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <TriageChat session={session} />
        <div className="flex flex-col gap-4">
          {session.entry_point === "integration:github" && session.trigger_payload && (
            <Card>
              <CardHeader>
                <CardTitle>Source Issue</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(() => {
                  const p = session.trigger_payload as GithubIssueTrigger;
                  return (
                    <>
                      <div className="font-medium">{p.source_issue_title}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        <a
                          href={`https://github.com/${p.source_issue_repo}/issues/${p.source_issue_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {p.source_issue_repo}#{p.source_issue_number}
                        </a>
                      </div>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Draft PRD</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-xs">
                {session.draft_prd ?? "No PRD drafted yet — keep grilling."}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
