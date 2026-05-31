import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
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
import { getBrief } from "@/lib/api/briefs";
import { getServerAuthToken } from "@/lib/auth-server";
import { formatRelativeAge } from "@/lib/utils";
import { TelemetryTab } from "@/components/briefs/TelemetryTab";
import { TimelineTab } from "@/components/briefs/TimelineTab";
import type { EventType, MajorEvent, Run, VerificationResult } from "@/lib/types";
import { RearmBriefButton } from "./_rearm-button";
import { RejectBriefButton } from "./_reject-button";

const TERMINAL = new Set(["done", "wontfix"]);

interface PageProps {
  params: { briefId: string };
  searchParams?: { tab?: string };
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "running";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function runNotes(run: Run): string {
  if (run.outcome === "cancelled" && run.cancellation_reason) {
    return run.cancellation_reason;
  }
  if (run.outcome === "succeeded" && run.num_turns !== null) {
    return `${run.num_turns} turns`;
  }
  return "";
}

function formatEventPayload(event: MajorEvent): React.ReactNode {
  const p = event.payload;
  switch (event.type as EventType) {
    case "status-transitioned": {
      const from = String(p.from ?? "");
      const to = String(p.to ?? "");
      const prUrl = p.pr_url ? String(p.pr_url) : null;
      return (
        <span className="font-mono text-xs">
          {from} <span className="text-muted-foreground">→</span> {to}
          {prUrl && (
            <>
              {" · "}
              <Link href={prUrl} target="_blank" className="text-primary underline-offset-4 hover:underline">
                PR ↗
              </Link>
            </>
          )}
        </span>
      );
    }
    case "run-started":
      return (
        <span className="font-mono text-xs text-muted-foreground">
          {String(p.purpose ?? "execute")}
        </span>
      );
    case "run-ended": {
      const reason = p.cancellation_reason ? String(p.cancellation_reason) : null;
      return (
        <span className="font-mono text-xs">
          {String(p.outcome ?? "")}
          {reason && <span className="text-muted-foreground"> · {reason}</span>}
        </span>
      );
    }
    case "pr-opened":
    case "pr-closed": {
      const prUrl = p.pr_url ? String(p.pr_url) : null;
      const merged = p.merged === true;
      return (
        <span className="font-mono text-xs">
          {event.type === "pr-closed" ? (merged ? "merged" : "closed") : "opened"}
          {prUrl && (
            <>
              {" · "}
              <Link href={prUrl} target="_blank" className="text-primary underline-offset-4 hover:underline">
                PR ↗
              </Link>
            </>
          )}
        </span>
      );
    }
    case "human-handoff":
      return (
        <span className="text-xs text-muted-foreground">{String(p.reason ?? "—")}</span>
      );
    case "brief-created":
      return <span className="text-xs text-muted-foreground">brief created</span>;
    case "relationship-added":
      return (
        <span className="font-mono text-xs">
          {String(p.type ?? "")}
          {p.related_brief_id !== undefined && (
            <>
              {" · "}
              <Link href={`/briefs/${String(p.related_brief_id)}`} className="text-primary underline-offset-4 hover:underline">
                #{String(p.related_brief_id)}
              </Link>
            </>
          )}
        </span>
      );
    case "content-revision-added":
      return (
        <span className="font-mono text-xs text-muted-foreground">
          rev {String(p.revision_number ?? "")}
        </span>
      );
    case "artifact-produced": {
      const ref = p.external_ref ? String(p.external_ref) : null;
      return (
        <span className="font-mono text-xs">
          {String(p.artifact_type ?? "")}
          {ref && (
            <>
              {" · "}
              <Link href={ref} target="_blank" className="text-primary underline-offset-4 hover:underline">
                ↗
              </Link>
            </>
          )}
        </span>
      );
    }
    case "queue-rank-set":
      return (
        <span className="font-mono text-xs text-muted-foreground">
          rank {String(p.rank ?? "")}
        </span>
      );
    default: {
      const keys = Object.keys(p);
      if (keys.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="font-mono text-xs text-muted-foreground">
          {JSON.stringify(p).slice(0, 80)}
          {JSON.stringify(p).length > 80 && "…"}
        </span>
      );
    }
  }
}

function groupVerificationByRun(
  results: VerificationResult[],
): Map<number, VerificationResult[]> {
  return results.reduce((acc, vr) => {
    const existing = acc.get(vr.run_id);
    if (existing) {
      existing.push(vr);
    } else {
      acc.set(vr.run_id, [vr]);
    }
    return acc;
  }, new Map<number, VerificationResult[]>());
}

export default async function BriefDetailPage({ params, searchParams }: PageProps) {
  const briefId = Number(params.briefId);
  if (Number.isNaN(briefId)) notFound();
  const authToken = await getServerAuthToken();
  const brief = await getBrief(briefId, authToken ?? undefined);
  if (!brief) notFound();

  const isTerminal = TERMINAL.has(brief.status);
  const prArtifact = brief.artifacts.find((a) => a.artifact_type === "git-change");

  const verificationByRun = groupVerificationByRun(brief.verification_results);
  const sortedVerificationRunIds = [...verificationByRun.keys()].sort((a, b) => b - a);
  const runById = new Map(brief.runs.map((r) => [r.id, r]));

  return (
    <AppShell active="/">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">
              #{brief.id}
            </h1>
            <StatusBadge status={brief.status} />
            {brief.classifications.map((c) => (
              <Badge key={c} variant="secondary">
                {c}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {brief.git_repository_ref ?? "no repo"} ·{" "}
            {brief.git_branch ?? "no branch"} ·{" "}
            queue_rank {brief.queue_rank ?? "—"} ·{" "}
            created {formatRelativeAge(brief.created_at)} ago
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
          {brief.status === "ready-for-human" && <RearmBriefButton briefId={brief.id} />}
          {!isTerminal && <RejectBriefButton briefId={brief.id} />}
        </div>
      </div>

      <Tabs defaultValue={searchParams?.tab ?? "timeline"}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="verification">Verification</TabsTrigger>
          <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          <TabsTrigger value="telemetry">Telemetry</TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
        </TabsList>

        {/* ── Timeline ── */}
        <TabsContent value="timeline">
          <TimelineTab
            runs={brief.runs}
            verifications={brief.verification_results}
            telemetryRecords={brief.telemetry_records}
            briefId={brief.id}
          />
        </TabsContent>

        {/* ── Content ── */}
        <TabsContent value="content">
          <Card>
            <CardHeader>
              <CardTitle>Current revision</CardTitle>
              <CardDescription>
                {brief.current_revision
                  ? `Rev ${brief.current_revision.revision_number} by ${brief.current_revision.author_actor}`
                  : "No revisions yet"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm prose-neutral max-w-none rounded-md bg-muted p-4 dark:prose-invert">
                <ReactMarkdown>
                  {brief.current_revision?.content_md ?? ""}
                </ReactMarkdown>
              </div>
            </CardContent>
          </Card>
          {brief.revisions.length > 1 && (
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
                    {brief.revisions.map((rev) => (
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

        {/* ── Events ── */}
        <TabsContent value="events">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {brief.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-mono text-xs">{event.type}</TableCell>
                      <TableCell className="font-mono text-xs">{event.actor}</TableCell>
                      <TableCell className="max-w-[400px]">
                        {formatEventPayload(event)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatRelativeAge(event.created_at)} ago
                      </TableCell>
                    </TableRow>
                  ))}
                  {brief.events.length === 0 && (
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

        {/* ── Runs ── */}
        <TabsContent value="runs">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Shell</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {brief.runs.map((run) => {
                    const notes = runNotes(run);
                    return (
                      <TableRow key={run.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          #{run.id}
                        </TableCell>
                        <TableCell className="text-xs">{run.purpose}</TableCell>
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
                        <TableCell className="font-mono text-xs">{run.shell_id ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDuration(run.started_at, run.ended_at)}
                        </TableCell>
                        <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                          {notes || "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {brief.runs.length === 0 && (
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

        {/* ── Verification ── */}
        <TabsContent value="verification">
          <Card>
            <CardHeader>
              <CardTitle>Verification results</CardTitle>
              <CardDescription>
                Checks run by each Shell execution, grouped by run — most recent first.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {sortedVerificationRunIds.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No verification results yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedVerificationRunIds.map((runId) => {
                      const checks = verificationByRun.get(runId) ?? [];
                      const run = runById.get(runId);
                      const passed = checks.filter((c) => c.outcome === "pass").length;
                      return (
                        <>
                          <TableRow key={`run-header-${runId}`} className="bg-muted/50">
                            <TableCell
                              colSpan={4}
                              className="py-2 font-mono text-xs font-medium text-muted-foreground"
                            >
                              Run #{runId}
                              {run && (
                                <span className="ml-2">
                                  <Badge
                                    variant={
                                      run.outcome === "succeeded"
                                        ? "default"
                                        : run.outcome === "running"
                                          ? "secondary"
                                          : "destructive"
                                    }
                                    className="text-xs"
                                  >
                                    {run.outcome}
                                  </Badge>
                                </span>
                              )}
                              <span className="ml-2 text-muted-foreground">
                                {passed}/{checks.length} passed
                              </span>
                            </TableCell>
                          </TableRow>
                          {checks.map((vr) => (
                            <TableRow key={vr.id}>
                              <TableCell className="pl-6 font-mono text-xs">{vr.check_name}</TableCell>
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
                              <TableCell className="text-xs">{vr.required ? "yes" : "no"}</TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {vr.requiredness_source ?? "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Artifacts ── */}
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
                  {brief.artifacts.map((artifact) => (
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
                  {brief.artifacts.length === 0 && (
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

        {/* ── Telemetry ── */}
        <TabsContent value="telemetry">
          <TelemetryTab runs={brief.runs} telemetryRecords={brief.telemetry_records} />
        </TabsContent>

        {/* ── Relationships ── */}
        <TabsContent value="relationships">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Related brief</TableHead>
                    <TableHead>Review requirement</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {brief.relationships.map((rel) => (
                    <TableRow key={rel.id}>
                      <TableCell>{rel.type}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <Link
                          href={`/briefs/${rel.related_brief.id}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          #{rel.related_brief.id}
                        </Link>
                      </TableCell>
                      <TableCell>{rel.parent_review_requirement}</TableCell>
                      <TableCell>
                        <StatusBadge status={rel.related_brief.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {brief.relationships.length === 0 && (
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
