"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [applyError, setApplyError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | "">("");
  const [pendingChangeSet, setPendingChangeSet] =
    useState<{ id: number; needs_human_apply: boolean } | null>(null);
  const [createdIssue, setCreatedIssue] =
    useState<{ url: string; number: number } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [issueCreateFailed, setIssueCreateFailed] = useState(false);
  const [isSending, startSend] = useTransition();
  const [isApplying, startApply] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    setApplyError(null);
    startApply(async () => {
      try {
        const token = await getSessionToken();
        const cs = await finalizeTriageSession(session.id, token ?? undefined);
        setPendingChangeSet({
          id: cs.id,
          needs_human_apply: cs.needs_human_apply,
        });

        if (selectedRepo) {
          setIssueCreateFailed(false);
          try {
            const issue = await createGithubIssue(session.id, selectedRepo, token ?? undefined);
            setCreatedIssue(issue);
          } catch {
            setIssueCreateFailed(true);
          }
        }

        router.refresh();
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : "Failed to finalize session");
      }
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
            <div ref={bottomRef} />
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
          {applyError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {applyError}
            </div>
          )}
          <div className="relative">
            <Textarea
              placeholder="Describe work…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isSending && draft.trim()) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={3}
              disabled={isSending || isClosed}
              className="pb-9 pr-10"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute bottom-2 right-2 h-7 w-7"
              aria-label="Send message"
              disabled={isSending || isClosed || !draft.trim()}
              onClick={handleSend}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
          {!isClosed && (
            <span className="self-end text-xs text-muted-foreground">
              ⌘/Ctrl+↩ to send
            </span>
          )}
          <div className="flex items-center justify-end gap-2">
            <Select
              value={selectedRepo}
              onValueChange={(v) => setSelectedRepo(v as Repo | "")}
              disabled={isApplying}
            >
              <SelectTrigger
                aria-label="Create GitHub issue in repository"
                className="w-[220px] text-sm"
              >
                <SelectValue placeholder="Create issue in… (optional)" />
              </SelectTrigger>
              <SelectContent>
                {REPOS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={isApplying || isClosed}
              onClick={() => setShowConfirm(true)}
            >
              {isApplying ? "Finalizing…" : "Finalize session"}
            </Button>
            <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Finalize this triage session?</DialogTitle>
                  <DialogDescription>
                    The conversation will close and a Change Set will be queued for review. This
                    cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowConfirm(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      setShowConfirm(false);
                      handleApply();
                    }}
                  >
                    Finalize session
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
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
              {issueCreateFailed && (
                <div className="text-amber-600 dark:text-amber-400">
                  Change Set created, but the GitHub issue could not be filed. You can retry from the source issue.
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
