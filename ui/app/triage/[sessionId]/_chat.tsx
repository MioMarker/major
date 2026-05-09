"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  finalizeTriageSession,
  sendTriageMessage,
} from "@/lib/api/triage";
import type { TriageMessage, TriageSession } from "@/lib/types";
import { cn } from "@/lib/utils";

export function TriageChat({ session }: { session: TriageSession }) {
  const router = useRouter();
  const [messages, setMessages] = useState<TriageMessage[]>(session.transcript);
  const [draft, setDraft] = useState("");
  const [pendingChangeSet, setPendingChangeSet] =
    useState<{ id: number; needs_human_apply: boolean } | null>(null);
  const [isSending, startSend] = useTransition();
  const [isApplying, startApply] = useTransition();

  function handleSend() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    startSend(async () => {
      const result = await sendTriageMessage(session.id, content);
      setMessages((prev) => [...prev, ...result.messages]);
    });
  }

  function handleApply() {
    startApply(async () => {
      const cs = await finalizeTriageSession(session.id);
      setPendingChangeSet({
        id: cs.id,
        needs_human_apply: cs.needs_human_apply,
      });
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
          <Textarea
            placeholder="Describe work…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            disabled={isSending}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={isSending || !draft.trim()}
              onClick={handleSend}
            >
              {isSending ? "Sending…" : "Send"}
            </Button>
            <Button
              size="sm"
              disabled={isApplying}
              onClick={handleApply}
            >
              {isApplying ? "Finalizing…" : "Apply →"}
            </Button>
          </div>
          {pendingChangeSet && (
            <div className="rounded-md border bg-muted p-3 text-xs">
              Change Set <span className="font-mono">#{pendingChangeSet.id}</span>{" "}
              {pendingChangeSet.needs_human_apply
                ? "queued for human apply (path-blocker tripped)."
                : "auto-applied."}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
