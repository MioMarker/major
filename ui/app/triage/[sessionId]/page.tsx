import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTriageSession } from "@/lib/api/triage";
import { TriageChat } from "./_chat";

interface PageProps {
  params: { sessionId: string };
}

export default async function TriageSessionPage({ params }: PageProps) {
  const sessionId = Number(params.sessionId);
  if (Number.isNaN(sessionId)) notFound();
  const session = await getTriageSession(sessionId);
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
    </AppShell>
  );
}
