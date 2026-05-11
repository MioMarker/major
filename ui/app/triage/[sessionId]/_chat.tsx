"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  createGithubIssue,
  finalizeTriageSession,
  sendTriageMessage,
} from "@/lib/api/triage";
import { getSessionToken } from "@/lib/auth";
import type { TriageMessage, TriageSession } from "@/lib/types";
import { cn } from "@/lib/utils";

const REPOS = [
  "MioMarker/major",
  "MioMarker/healthbite",
  "MioMarker/healix",
] as const;

type Repo = (typeof REPOS)[number];

export function TriageChat({ session }: { session: TriageSession }) {
  const router = useRouter();
  const [messages, setMessages] = useState<TriageMessage[]>(session.transcript);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | "">("");
  const [pendingChangeSet, setPendingChangeSet] =
    useState<{ id: number; needs_human_apply: boolean } | null>(null);
  const [createdIssue, setCreatedIssue] =
    useState<{ url: string; number: number } | null>(null);
  const [isSending, startSend] = useTransition();
  const [isApplying, startApply] = useTransition();

  const isClosed = session.status === "closed";

  function handleSend() {
    const content = draft.trim();
    if (!content || isClosed) return;
    setDraft("");
    setSendError(null);
    startSend(async () => {
      try {
        const token = await getSessionToken();
        const result = await sendTriageMessage(session.id, content, token ?? undefined);
        setMessages((prev) => [...prev, ...result.messages]);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Failed to send");
      }
    });
  }

  function handleApply() {
    startApply(async () => {
      const token = await getSessionToken();
      const cs = await finalizeTriageSession(session.id, token ?? undefined);
      setPendingChangeSet({
        id: cs.id,
        needs_human_apply: cs.needs_human_apply,
      });

      if (selectedRepo) {
        try {
          const issue = await createGithubIssue(session.id, selectedRepo, token ?? undefined);
          setCreatedIssue(issue);
        } catch {
          // Issue creation is best-effort; change set already applied.
        }
      }

      router.refresh();
    });
  }

  return (
    <Card className="flex h-[600px] flex-col">
      <CardHeader>
        <CardTitle>Conversation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden">
        <ScrollArea className="flex-1 rounded-md border bg-background">
          <div className="flex flex-col gap-3 p-4">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={cn(
                  "max-w-[80%] rounded-md p-3 text-sm",
                  msg.role === "human"
                    ? "self-end bg-primary text-primary-foreground"
                    : "self-start bg-muted",
                )}
              >
                <div className="mb-1 text-xs font-mono opacity-70">{msg.role}</div>
                {msg.content}
              </div>
            ))}
            {messages.length === 0 && (
              <div className="text-sm text-muted-foreground">
                No messages yet. Describe the work; the agent will grill.
              </div>
            )}
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-2">
          {isClosed && (
            <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
              This session is closed. Start a new session to continue triaging.
            </div>
          )}
          {sendError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {sendError}
            </div>
          )}
          <Textarea
            placeholder="Describe work…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey && !isSending && draft.trim()) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={3}
            disabled={isSending || isClosed}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={isSending || isClosed || !draft.trim()}
              onClick={handleSend}
            >
              {isSending ? "Sending…" : "Send"}
            </Button>
            <div className="flex items-center gap-2">
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value as Repo | "")}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                disabled={isApplying}
              >
                <option value="" disabled>Create issue in&hellip; (optional)</option>
                {REPOS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={isApplying || isClosed}
                onClick={handleApply}
              >
                {isApplying ? "Submitting…" : "Submit →"}
              </Button>
            </div>
          </div>
          {pendingChangeSet && (
            <div className="rounded-md border bg-muted p-3 text-xs space-y-1">
              <div>
                Change Set <span className="font-mono">#{pendingChangeSet.id}</span>{" "}
                {pendingChangeSet.needs_human_apply
                  ? "queued for human apply (path-blocker tripped)."
                  : "auto-applied."}
              </div>
              {createdIssue && (
                <div>
                  GitHub issue created:{" "}
                  <a
                    href={createdIssue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-primary underline-offset-2 hover:underline"
                  >
                    #{createdIssue.number}
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
