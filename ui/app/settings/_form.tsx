"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { updateSettings } from "@/lib/api/settings";
import type { SettingsPayload } from "@/lib/types";

export function SettingsForm({ settings }: { settings: SettingsPayload }) {
  const [globsText, setGlobsText] = useState(settings.protected_globs.join("\n"));
  const [massRerank, setMassRerank] = useState(settings.mass_rerank_threshold);
  const [runnerHint, setRunnerHint] = useState(settings.runner_pool_size_hint);
  const [autoTriageEnabled, setAutoTriageEnabled] = useState(
    settings.auto_triage_enabled,
  );
  const [autoTriageOnNew, setAutoTriageOnNew] = useState(
    settings.auto_triage_on_new_items,
  );
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const next: SettingsPayload = {
      protected_globs: globsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      mass_rerank_threshold: massRerank,
      runner_pool_size_hint: runnerHint,
      auto_triage_enabled: autoTriageEnabled,
      auto_triage_on_new_items: autoTriageOnNew,
    };
    startTransition(async () => {
      await updateSettings(next);
      setSavedAt(new Date().toLocaleTimeString());
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Path-blocker rule</CardTitle>
          <CardDescription>
            One glob per line. Items whose <code>expected_paths</code>{" "}
            intersect any glob require human apply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={globsText}
            onChange={(e) => setGlobsText(e.target.value)}
            rows={8}
            className="font-mono text-xs"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mass-rerank threshold</CardTitle>
          <CardDescription>
            Auto Triage Run change sets touching more than this many{" "}
            <code>queue_rank</code> values trip the path-blocker.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            type="number"
            min={1}
            value={massRerank}
            onChange={(e) =>
              setMassRerank(Math.max(1, Number(e.target.value || 1)))
            }
            className="max-w-xs"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runner pool size hint</CardTitle>
          <CardDescription>
            Advisory only. Actual count is set by the runner host environment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            type="number"
            min={0}
            value={runnerHint}
            onChange={(e) =>
              setRunnerHint(Math.max(0, Number(e.target.value || 0)))
            }
            className="max-w-xs"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-triage policy</CardTitle>
          <CardDescription>
            Toggles the optional Auto Triage Run scheduling.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={autoTriageEnabled}
              onChange={(e) => setAutoTriageEnabled(e.target.checked)}
            />
            Auto-triage enabled
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={autoTriageOnNew}
              onChange={(e) => setAutoTriageOnNew(e.target.checked)}
              disabled={!autoTriageEnabled}
            />
            Schedule auto-triage on new items
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {savedAt ? `Saved at ${savedAt}` : "Unsaved changes"}
        </div>
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
