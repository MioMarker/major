import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { listQaBriefs } from "@/lib/api/briefs";
import { getServerAuthToken } from "@/lib/auth-server";
import { formatRelativeAge } from "@/lib/utils";
import { ConfirmQaButton } from "./_confirm-qa-button";

export default async function PendingQaPage() {
  const authToken = await getServerAuthToken();
  const briefs = await listQaBriefs(authToken ?? undefined);

  return (
    <AppShell active="/qa">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pending QA</h1>
        <p className="text-sm text-muted-foreground">
          Briefs in <code>ready-for-review</code> waiting for human acceptance.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {briefs.map((brief) => (
          <Card key={brief.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="font-mono text-base">
                    <Link
                      href={`/briefs/${brief.id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      #{brief.id}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {brief.git_repository_ref ?? "no repo"}
                    {brief.git_branch ? ` · ${brief.git_branch}` : ""}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  {brief.classifications.map((c) => (
                    <Badge key={c} variant="secondary">
                      {c}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground">
                <div>
                  PR status: <span className="font-mono">{brief.pr_status}</span>
                </div>
                {brief.pr_url && (
                  <Link
                    href={brief.pr_url}
                    target="_blank"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Open PR ↗
                  </Link>
                )}
                <div>Updated {formatRelativeAge(brief.updated_at)} ago</div>
              </div>
              <ConfirmQaButton briefId={brief.id} prMerged={brief.pr_status === "merged"} />
            </CardContent>
          </Card>
        ))}
        {briefs.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Nothing waiting for QA right now.
          </div>
        )}
      </div>
    </AppShell>
  );
}
