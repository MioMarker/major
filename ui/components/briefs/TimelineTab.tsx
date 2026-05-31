"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { Run, VerificationResult, TelemetryRecord } from "@/lib/types";
import { buildTimeline } from "@/lib/timeline";
import { RunSection } from "./RunSection";

interface TimelineTabProps {
  runs: Run[];
  verifications: VerificationResult[];
  telemetryRecords: TelemetryRecord[];
  briefId: number;
}

export function TimelineTab({
  runs,
  verifications,
  telemetryRecords,
  briefId,
}: TimelineTabProps) {
  const timeline = buildTimeline(runs, verifications, telemetryRecords);

  if (timeline.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No runs yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {timeline.map((timelineRun) => (
        <RunSection
          key={timelineRun.run.id}
          timelineRun={timelineRun}
          briefId={briefId}
          defaultExpanded={timelineRun.isCurrent}
        />
      ))}
    </div>
  );
}
