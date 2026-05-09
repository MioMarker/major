import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getItem } from "@/lib/api/items";
import { formatRelativeAge } from "@/lib/utils";
import { RejectItemButton } from "./_reject-button";

const TERMINAL = new Set(["done", "wontfix"]);

interface PageProps {
  params: { itemId: string };
}

export default async function ItemDetailPage({ params }: PageProps) {
  const itemId = Number(params.itemId);
  if (Number.isNaN(itemId)) notFound();
  const item = await getItem(itemId);
  if (!item) notFound();

  const isTerminal = TERMINAL.has(item.status);
  const prArtifact = item.artifacts.find((a) => a.artifact_type === "git-change");

  return (
    <AppShell active="/">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              #{item.id}
            </h1>
            <StatusBadge status={item.status} />
            {item.classifications.map((c) => (
              <Badge key={c} variant="secondary">
                {c}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {item.git_repository_ref ?? "no repo"} ·{" "}
            {item.git_branch ?? "no branch"} ·{" "}
            queue_rank {item.queue_rank ?? "—"} ·{" "}
            created {formatRelativeAge(item.created_at)} ago
          </p>
        </div>
        <div className="flex items-center gap-2">
          {prArtifact?.external_ref && (
            <Link
              href={prArtifact.external_ref}
              target="_blank"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              PR ↗
            </Link>
          )}
          {!isTerminal && <RejectItemButton itemId={item.id} />}
        </div>
      </div>

      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
        </TabsList>

        <TabsContent value="content">
          <Card>
            <CardHeader>
              <CardTitle>Current revision</CardTitle>
              <CardDescription>
                {item.current_revision
                  ? `Rev ${item.current_revision.revision_number} by ${item.current_revision.author_actor}`
                  : "No revisions yet"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-xs">
                {item.current_revision?.content_md ?? "—"}
              </pre>
            </CardContent>
          </Card>
          {item.revisions.length > 1 && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>Revision history</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Author</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {item.revisions.map((rev) => (
                      <TableRow key={rev.id}>
                        <TableCell className="font-mono text-xs">
                          {rev.revision_number}
                        </TableCell>
                        <TableCell>{rev.author_actor}</TableCell>
                        <TableCell>{rev.reason ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeAge(rev.created_at)} ago
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="events">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Payload</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-mono text-xs">{event.type}</TableCell>
                      <TableCell className="font-mono text-xs">{event.actor}</TableCell>
                      <TableCell className="max-w-[320px] truncate font-mono text-xs text-muted-foreground">
                        {Object.keys(event.payload).length === 0
                          ? "—"
                          : JSON.stringify(event.payload)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeAge(event.created_at)} ago
                      </TableCell>
                    </TableRow>
                  ))}
                  {item.events.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        No events recorded.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Runner</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Ended</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="font-mono text-xs">#{run.id}</TableCell>
                      <TableCell>{run.purpose}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            run.outcome === "succeeded"
                              ? "default"
                              : run.outcome === "running"
                                ? "secondary"
                                : "destructive"
                          }
                        >
                          {run.outcome}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{run.runner_id ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeAge(run.started_at)} ago
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {run.ended_at ? `${formatRelativeAge(run.ended_at)} ago` : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                  {item.runs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                        No runs yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="verification">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Run</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.verification_results.map((vr) => (
                    <TableRow key={vr.id}>
                      <TableCell className="font-mono text-xs">{vr.check_name}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            vr.outcome === "pass"
                              ? "default"
                              : vr.outcome === "fail"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {vr.outcome}
                        </Badge>
                      </TableCell>
                      <TableCell>{vr.required ? "yes" : "no"}</TableCell>
                      <TableCell className="font-mono text-xs">{vr.requiredness_source ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">#{vr.run_id}</TableCell>
                    </TableRow>
                  ))}
                  {item.verification_results.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        No verification results yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="artifacts">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>External ref</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.artifacts.map((artifact) => (
                    <TableRow key={artifact.id}>
                      <TableCell className="font-mono text-xs">{artifact.artifact_type}</TableCell>
                      <TableCell className="text-xs">
                        {artifact.external_ref ? (
                          <Link
                            href={artifact.external_ref}
                            target="_blank"
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {artifact.external_ref}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {artifact.run_id ? `#${artifact.run_id}` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeAge(artifact.created_at)} ago
                      </TableCell>
                    </TableRow>
                  ))}
                  {item.artifacts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        No artifacts produced.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="relationships">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Related item</TableHead>
                    <TableHead>Review requirement</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {item.relationships.map((rel) => (
                    <TableRow key={rel.id}>
                      <TableCell>{rel.type}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/items/${rel.related_item.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          #{rel.related_item.id}
                        </Link>
                      </TableCell>
                      <TableCell>{rel.parent_review_requirement}</TableCell>
                      <TableCell>
                        <StatusBadge status={rel.related_item.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {item.relationships.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        No relationships.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
