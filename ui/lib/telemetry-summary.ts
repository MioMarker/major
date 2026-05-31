import type { TelemetryRecord } from "./types";

export type SummaryTone = "default" | "muted" | "destructive" | "info";

export type SummaryIcon =
  | "bash"
  | "tool-result"
  | "assistant"
  | "system"
  | "denied"
  | "error"
  | "info";

export interface TelemetrySummary {
  icon: SummaryIcon;
  label: string;
  tone: SummaryTone;
  lines: ReadonlyArray<string>;
}

const MAX_LINE = 140;

function trunc(s: string, n: number = MAX_LINE): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): ReadonlyArray<unknown> {
  return Array.isArray(v) ? v : [];
}

function summarizeBashObserved(payload: Record<string, unknown>): TelemetrySummary {
  const command = asString(payload.command);
  const decision = asString(payload.decision);
  if (decision === "denied") {
    const rule = asString(payload.matched_rule);
    return {
      icon: "denied",
      label: "Bash denied",
      tone: "destructive",
      lines: [`$ ${trunc(command)}`, rule ? `rule: ${rule}` : "denied by sandbox hook"],
    };
  }
  return {
    icon: "bash",
    label: "Bash observed",
    tone: "muted",
    lines: [`$ ${trunc(command)}`],
  };
}

function summarizeToolUse(toolName: string, input: Record<string, unknown>, description: string): TelemetrySummary {
  const lines: string[] = [];
  switch (toolName) {
    case "Bash": {
      lines.push(`$ ${trunc(asString(input.command))}`);
      if (description) lines.push(`"${trunc(description, 100)}"`);
      return { icon: "bash", label: "Bash", tone: "default", lines };
    }
    case "Read": {
      lines.push(asString(input.file_path) || "(no path)");
      const offset = input.offset;
      const limit = input.limit;
      if (typeof offset === "number" || typeof limit === "number") {
        lines.push(`offset=${offset ?? 0} limit=${limit ?? "?"}`);
      }
      return { icon: "assistant", label: "Read", tone: "default", lines };
    }
    case "Edit": {
      lines.push(asString(input.file_path) || "(no path)");
      const oldStr = asString(input.old_string);
      if (oldStr) lines.push(`− ${trunc(oldStr, 100)}`);
      return { icon: "assistant", label: "Edit", tone: "default", lines };
    }
    case "Write": {
      lines.push(asString(input.file_path) || "(no path)");
      const content = asString(input.content);
      if (content) lines.push(`(${content.length} chars)`);
      return { icon: "assistant", label: "Write", tone: "default", lines };
    }
    case "Glob":
    case "Grep": {
      lines.push(asString(input.pattern) || asString(input.query) || "(no pattern)");
      const path = asString(input.path);
      if (path) lines.push(`in ${path}`);
      return { icon: "assistant", label: toolName, tone: "default", lines };
    }
    default: {
      const inputKeys = Object.keys(input);
      const head = inputKeys.length ? trunc(JSON.stringify(input), 120) : "(no input)";
      lines.push(head);
      if (description) lines.push(`"${trunc(description, 100)}"`);
      return { icon: "assistant", label: toolName || "Tool use", tone: "default", lines };
    }
  }
}

function summarizeStreamEvent(payload: Record<string, unknown>): TelemetrySummary {
  const body = asObject(payload.body);
  if (!body) {
    return { icon: "info", label: "Stream event", tone: "muted", lines: ["(empty body)"] };
  }
  const bodyType = asString(body.type);

  if (bodyType === "system") {
    const subtype = asString(body.subtype);
    return {
      icon: "system",
      label: subtype ? `System: ${subtype}` : "System",
      tone: "muted",
      lines: [trunc(JSON.stringify(body), 200)],
    };
  }

  if (bodyType === "result") {
    const subtype = asString(body.subtype);
    const error = asString(body.error);
    return {
      icon: error ? "error" : "info",
      label: subtype ? `Result: ${subtype}` : "Result",
      tone: error ? "destructive" : "info",
      lines: error ? [error] : [trunc(JSON.stringify(body), 200)],
    };
  }

  const message = asObject(body.message);
  const role = message ? asString(message.role) : "";
  const content = message ? asArray(message.content) : [];

  if (role === "assistant") {
    for (const block of content) {
      const b = asObject(block);
      if (!b) continue;
      const blockType = asString(b.type);
      if (blockType === "tool_use") {
        const name = asString(b.name);
        const input = asObject(b.input) ?? {};
        const description = asString(input.description);
        return summarizeToolUse(name, input, description);
      }
      if (blockType === "text") {
        const text = asString(b.text);
        if (text) {
          return {
            icon: "assistant",
            label: "Assistant",
            tone: "default",
            lines: [trunc(text, 280)],
          };
        }
      }
    }
    // No content blocks worth surfacing — likely a usage-only update.
    const usage = asObject(message?.usage);
    if (usage) {
      const inT = usage.input_tokens ?? 0;
      const outT = usage.output_tokens ?? 0;
      return {
        icon: "assistant",
        label: "Assistant (usage)",
        tone: "muted",
        lines: [`tokens in: ${inT}, out: ${outT}`],
      };
    }
    return { icon: "assistant", label: "Assistant", tone: "muted", lines: ["(no content)"] };
  }

  if (role === "user") {
    for (const block of content) {
      const b = asObject(block);
      if (!b) continue;
      const blockType = asString(b.type);
      if (blockType === "tool_result") {
        const isError = b.is_error === true;
        const c = b.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((x) => (typeof x === "object" && x && "text" in x ? String((x as { text: unknown }).text) : "")).join("\n")
          : "";
        const lines = text
          ? text.split("\n").slice(0, 3).map((l) => trunc(l, 160))
          : ["(no output)"];
        return {
          icon: "tool-result",
          label: isError ? "Tool result (error)" : "Tool result",
          tone: isError ? "destructive" : "default",
          lines,
        };
      }
    }
    return { icon: "tool-result", label: "User", tone: "muted", lines: ["(no content)"] };
  }

  return { icon: "info", label: bodyType || "Stream event", tone: "muted", lines: [trunc(JSON.stringify(body), 200)] };
}

/** Telemetry records that must appear as inline rows (never hidden behind chip). */
export function isExceptionalTelemetry(rec: TelemetryRecord): boolean {
  if (rec.observation_type === "tachikoma-bash-observed") {
    return rec.payload.decision === "denied";
  }
  return (
    rec.observation_type === "tachikoma-stream-parse-errors" ||
    rec.observation_type === "external-system-error"
  );
}

/** One-line chip text for a run's routine telemetry: "N steps · M commands". */
export function telemetryChipText(records: ReadonlyArray<TelemetryRecord>): string {
  let steps = 0;
  let commands = 0;
  for (const rec of records) {
    if (rec.observation_type === "tachikoma-stream-event") steps++;
    else if (rec.observation_type === "tachikoma-bash-observed") commands++;
  }
  return `${steps} steps · ${commands} commands`;
}

export function summarizeTelemetry(rec: TelemetryRecord): TelemetrySummary {
  const t = rec.observation_type;
  if (t === "tachikoma-bash-observed") return summarizeBashObserved(rec.payload);
  if (t === "tachikoma-stream-event") return summarizeStreamEvent(rec.payload);
  if (t === "tachikoma-stream-parse-errors") {
    const count = rec.payload.count;
    return {
      icon: "error",
      label: "Stream parse errors",
      tone: "destructive",
      lines: [`${count} parse error${count === 1 ? "" : "s"} during this run`],
    };
  }
  if (t === "external-system-error") {
    const stage = asString(rec.payload.stage);
    const error = asString(rec.payload.error);
    return {
      icon: "error",
      label: stage ? `External error · ${stage}` : "External error",
      tone: "destructive",
      lines: [trunc(error || "(no error message)", 240)],
    };
  }
  return {
    icon: "info",
    label: t,
    tone: "muted",
    lines: [trunc(JSON.stringify(rec.payload), 200)],
  };
}
