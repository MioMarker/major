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
import { listQaItems } from "@/lib/api/items";
import { formatRelativeAge } from "@/lib/utils";
import { ConfirmQaButton } from "./_confirm-qa-button";

export default async function PendingQaPage() {
  const items = await listQaItems();

  return (
    <AppShell active="/qa">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pending QA</h1>
        <p className="text-sm text-muted-foreground">
          Items in <code>ready-for-review</code> waiting for human acceptance.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="font-mono text-base">
                    <Link
                      href={`/items/${item.id}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      #{item.id}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {item.git_repository_ref ?? "no repo"}
                    {item.git_branch ? ` · ${item.git_branch}` : ""}
                  </CardDescription>
                </div>
                <div className="flex gap-1">
                  {item.classifications.map((c) => (
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
                  PR status: <span className="font-mono">{item.pr_status}</span>
                </div>
                {item.pr_url && (
                  <Link
                    href={item.pr_url}
                    target="_blank"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Open PR ↗
                  </Link>
                )}
                <div>Updated {formatRelativeAge(item.updated_at)} ago</div>
              </div>
              <ConfirmQaButton itemId={item.id} prMerged={item.pr_status === "merged"} />
            </CardContent>
          </Card>
        ))}
        {items.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Nothing waiting for QA right now.
          </div>
        )}
      </div>
    </AppShell>
  );
}
