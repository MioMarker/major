"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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
  const [autoTriageEnabled, setAutoTriageEnabled] = useState(
    settings.auto_triage_enabled,
  );
  const [autoTriageOnNew, setAutoTriageOnNew] = useState(
    settings.auto_triage_on_new_briefs,
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const next: SettingsPayload = {
      protected_globs: globsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      mass_rerank_threshold: massRerank,
      shell_pool_size_hint: settings.shell_pool_size_hint,
      auto_triage_enabled: autoTriageEnabled,
      auto_triage_on_new_briefs: autoTriageOnNew,
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
            Schedule auto-triage on new briefs
          </label>
        </CardContent>
      </Card>

      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Advanced settings
        </button>

        {advancedOpen && (
          <div className="mt-3 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Path-blocker rule</CardTitle>
                <CardDescription>
                  One glob per line. Briefs whose <code>expected_paths</code>{" "}
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
          </div>
        )}
      </div>

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
