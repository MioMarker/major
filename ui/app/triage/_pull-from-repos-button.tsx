"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { importExternalIssues, listExternalIssues } from "@/lib/api/triage";
import { getSessionToken } from "@/lib/auth";
import type { ExternalIssue } from "@/lib/types";
import { formatRelativeAge } from "@/lib/utils";

export function PullFromReposButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isImporting, startImport] = useTransition();

  useEffect(() => {
    if (!open) return;
    setIssues([]);
    setFetchError(false);
    setSelected(new Set());
    setLoading(true);
    getSessionToken()
      .then((token) => listExternalIssues(token ?? undefined))
      .then((data) => setIssues(data))
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [open]);

  function issueKey(issue: ExternalIssue) {
    return `${issue.repo}:${issue.number}`;
  }

  function toggleRow(issue: ExternalIssue) {
    const key = issueKey(issue);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleImport() {
    const toImport = issues
      .filter((i) => selected.has(issueKey(i)))
      .map((i) => ({ repo: i.repo, number: i.number }));
    startImport(async () => {
      const token = await getSessionToken();
      await importExternalIssues(toImport, token ?? undefined);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Pull from repos
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Pull from repos</DialogTitle>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[32px]">
                    <input
                      type="checkbox"
                      checked={issues.length > 0 && selected.size === issues.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selected.size > 0 && selected.size < issues.length;
                      }}
                      onChange={() => {
                        if (selected.size === issues.length) {
                          setSelected(new Set());
                        } else {
                          setSelected(new Set(issues.map(issueKey)));
                        }
                      }}
                      disabled={issues.length === 0}
                      className="h-4 w-4 rounded border-border"
                    />
                  </TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead className="w-[60px]">#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead className="w-[80px]">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading &&
                  [0, 1, 2].map((i) => (
                    <TableRow key={i}>
                      {[0, 1, 2, 3, 4, 5].map((j) => (
                        <TableCell key={j}>
                          <div className="h-4 w-full animate-pulse rounded bg-muted" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {!loading && fetchError && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-6 text-center text-sm text-destructive">
                      Failed to load issues — check GitHub token configuration.
                    </TableCell>
                  </TableRow>
                )}
                {!loading && !fetchError && issues.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      No issues labeled <code>needs-triage</code> found across registered repos.
                    </TableCell>
                  </TableRow>
                )}
                {!loading &&
                  !fetchError &&
                  issues.map((issue) => {
                    const key = issueKey(issue);
                    const checked = selected.has(key);
                    return (
                      <TableRow
                        key={key}
                        className="cursor-pointer"
                        onClick={() => toggleRow(issue)}
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(issue)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded border-border"
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{issue.repo}</TableCell>
                        <TableCell className="font-mono text-xs">#{issue.number}</TableCell>
                        <TableCell className="text-sm">
                          <a
                            href={issue.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary underline-offset-2 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {issue.title}
                          </a>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {issue.labels.map((label) => (
                              <Badge key={label} variant="secondary" className="text-xs">
                                {label}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelativeAge(issue.created_at)} ago
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              disabled={selected.size === 0 || isImporting}
              onClick={handleImport}
            >
              {isImporting ? "Importing…" : `Import selected (${selected.size})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
