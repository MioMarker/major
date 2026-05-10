# 006. Structured Tachikoma telemetry via Claude Code stream-json output

## Status

Accepted

Date: 2026-05-09

## Context

Major's Run-level telemetry is coarse. The `major-claim-brief` and `major-finalize-run` edge functions persist `run-started` and `run-ended` Events, and `major.runs` records terminal `outcome`, `started_at`, `ended_at`, and a few transactional fields. What it does **not** record:

- Number of LLM turns the Tachikoma took to reach completion.
- Latency per turn.
- Tool invocations the Tachikoma made and which succeeded vs. failed.
- Token usage (input / output / cache).
- The final assistant message text (currently captured ad-hoc, if at all).

For the AFK-loop premise this is enough today — the Brief lifecycle moves and Runs finalize. But it leaves real gaps:

- **Diagnosing slow Runs** is forensic. We can see total wall time but not whether a Run took 30 minutes because of one giant turn or 200 short ones.
- **Cost attribution** is missing. Without per-Run token counts, monthly Anthropic spend cannot be allocated to Briefs.
- **Tool-failure signal** is invisible. A Tachikoma whose `Edit` tool calls fail silently and is then asked to retry has no Run-level signal — only the eventual "implementer wrote no patch" outcome.
- **Replay reproducibility** is partial. The Run records which prompt version it used, but not the actual conversation shape.

Claude Code already supports `--output-format stream-json` natively: a structured event stream emitted line-by-line during execution, with a final completion event carrying summary metrics. The Shell currently invokes Tachikoma without that flag and falls back to parsing fenced JSON in unstructured stdout (`shell/tachikoma.ts` `parseStructuredOutput`). Switching to stream-json gives Major the same observability for free, and a place to record per-event Telemetry without inventing a parser.

This ADR adopts stream-json output and persists each event as a Telemetry Record, with summary metrics hoisted to columns on `major.runs`.

### Events vs. Telemetry Records

The original draft of this proposal reused `major.events` for per-event observations. That conflates two distinct primitives.

`docs/CONTEXT.md` is explicit on the distinction. **Events** are lifecycle-authoritative: they drive Brief Status, they are read by lifecycle code, and the `events.idempotency_key` discipline (per `.claude/rules/functions/edge-functions.md`) anchors replayable lifecycle writes. **Telemetry Records** are non-lifecycle observations: heartbeat lapses, retry attempts, external-system errors, behavior the operator wants to see in postmortems but no lifecycle code reads.

Stream-json events are observation, not lifecycle. The Tachikoma emitting "I called the `Edit` tool with these args" does not transition a Brief, does not start a Run, does not end a Run. It is exactly the shape Telemetry Records exist for. This ADR therefore lands per-event observations in `major.telemetry_records`, not `major.events`.

The Run-level lifecycle Events (`run-started`, `run-ended`) are unchanged. They keep their authority. The stream-json telemetry sits beside them.

### Alternatives considered

1. **Post-hoc parse Tachikoma logs.** Keep current invocation; parse plain-text stdout after Run completion. Rejected: lossy (Anthropic may change log format), retrospective only, no live signal during the Run.

2. **Instrument the Tachikoma with a custom event emitter.** Have the Tachikoma write JSONL to a known fd that the Shell reads. Rejected: the Tachikoma is upstream Claude Code and Major does not fork. The proposal would mean reimplementing Anthropic's existing capability.

3. **Use Claude Code's `--output-format stream-json` and reuse `major.events` for per-event observations.** This was the original Proposal 04 shape. Rejected: conflates lifecycle Events with non-lifecycle observation, contradicts CONTEXT.md, and would force lifecycle code paths to filter out telemetry rows by `event_type`. Cleaner to use the table that already exists for non-lifecycle observation.

4. **Use Claude Code's `--output-format stream-json` and persist per-event observations to `major.telemetry_records`; hoist summary metrics to columns on `major.runs` (chosen).** First-party tool, clean primitive boundary, summary metrics directly queryable without joins.

5. **Skip telemetry; rely on monthly Anthropic billing reports for cost.** Rejected: solves the cost question in aggregate but leaves diagnosis and reproducibility gaps. Stream-json is cheap to adopt.

### Forces

- **First-party, no fork.** The Shell consumes stream-json from Claude Code as Anthropic ships it. If the format changes, we update the parser, not the Tachikoma.
- **Idempotency keys.** Each Telemetry write needs a stable key so a Shell that crashes mid-Run and resumes does not double-write. Stream-json events are sequential within a Run; the key is `(run_id, 'tachikoma-stream-event', shell_id, sequence)`. Sequence numbers are persisted on the Run row, not held only in Shell memory.
- **Defense-in-depth, don't degrade.** If stream-json parsing fails (malformed event, parser error), the Run must still finalize correctly. Telemetry is observational; it does not gate lifecycle.
- **Secret hygiene.** Telemetry persists snippets of Tachikoma stdout. The wrapper's secret-sanitization (`.claude/rules/shell/sandbox-discipline.md` § "Never Log Secrets") runs on every Telemetry Record before insert, not only on final transcript logs.
- **Storage shape over storage cap.** A talkative Tachikoma can emit hundreds of events per Run, but the cost of an unbounded distribution is hypothetical until calibrated. Ship without a hard per-Run cap; observe the actual distribution; calibrate later.

## Decision

The Shell invokes the Tachikoma with `--output-format stream-json` and persists structured Telemetry per event. Summary metrics hoist into new columns on `major.runs`. The final assistant text lands in a new `runs.final_text` column. There is no new Brief Artifact, no new Event type, and no new artifact-type-contracts row.

### Invocation change

In `shell/tachikoma.ts`, add `--output-format stream-json` to the Claude Code argv. The Shell reads stdout line-by-line, JSON-parsing each line as it arrives.

### Schema additions

A single migration adds these columns to `major.runs`. All are nullable except the sequence counter, which has a default and so is safe to add as `NOT NULL` on existing rows:

```sql
ALTER TABLE major.runs
  ADD COLUMN num_turns                 integer,
  ADD COLUMN duration_ms               integer,
  ADD COLUMN final_text                text,
  ADD COLUMN input_tokens              integer,
  ADD COLUMN output_tokens             integer,
  ADD COLUMN cache_read_tokens         integer,
  ADD COLUMN cache_write_tokens        integer,
  ADD COLUMN tachikoma_event_sequence  integer NOT NULL DEFAULT 0;
```

No new table. No new artifact type. The `final_text` column carries the full final assistant message; size is bounded by the Tachikoma's own output budget.

### Per-event Telemetry write

For each stream-json event the Shell receives:

1. Parse the JSON line. If parse fails, log to container stdout with `[Shell]` prefix, increment a per-Run parse-error counter (Shell-side, surfaced in the `run-ended` payload), and continue. Telemetry parse failure does **not** abort the Run.
2. Sanitize for known secret patterns (Anthropic key, Supabase service-role key, GitHub token) per the existing sanitizer. A match replaces the value with `[REDACTED]` before any further handling.
3. Atomically increment `runs.tachikoma_event_sequence` and capture the new value as `sequence`. The increment is `UPDATE major.runs SET tachikoma_event_sequence = tachikoma_event_sequence + 1 WHERE id = $1 RETURNING tachikoma_event_sequence` inside a transaction.
4. Write a Telemetry Record:
   - `observation_type = 'tachikoma-stream-event'`
   - `payload = { eventKind, body, shell_id, sequence }`
   - `idempotency_key` shape: `(run_id, 'tachikoma-stream-event', shell_id, sequence)`
5. A failed write rolls back the sequence increment within the same transaction, so the next attempt reuses the same sequence value. Combined with the idempotency key, retried writes collapse to a no-op success.

### Final completion event

The final completion event triggers special handling **inside the existing Run Finalization Transaction** (`major-finalize-run`, per `.claude/rules/functions/edge-functions.md`):

1. Hoist summary metrics into `major.runs`: `num_turns`, `duration_ms`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`.
2. Write the final assistant message verbatim into `runs.final_text` (after sanitization).
3. Fold summary metrics into the existing `run-ended` Event payload alongside the existing `outcome` and `cancellation_reason` fields. No new event type.

The original proposal's `tachikoma-completion` Event is dropped — `run-ended` carries the summary, and the per-event Telemetry stream carries the detail. The original proposal's `tachikoma-final-text` Brief Artifact is dropped — `runs.final_text` carries the text, no artifact-type-contracts row needed.

All of this is inside the existing Run Finalization Transaction; the stream-json parsing does not introduce a separate transaction.

### No per-Run cap in v1

The original proposal capped per-Run Telemetry at 1000 events. Dropped. Major has no calibration data on the actual stream-json event distribution; an arbitrary cap risks truncating exactly the long Run a postmortem most needs. Ship without a cap, observe the distribution, and calibrate from evidence later. Tracked as follow-on.

### Scope of this ADR

In scope: invocation change, per-event Telemetry write path, idempotency-key shape, Run-row column additions, final-completion handling inside Run Finalization, sequence-counter discipline, secret sanitization on every write.

Out of scope: live UI streaming of Telemetry (Brief Detail polls `major.events` today; live SSE is a separate ADR if pursued); cross-Run aggregation queries (analytics is a separate concern); cost-allocation reports (downstream of these columns existing); retention policy for `tachikoma-stream-event` rows (separate ADR).

## Consequences

### Positive

- Per-Run observability: turn count, latency, token usage, tool-call shape — all queryable.
- Cost attribution becomes possible. Token counts per Run roll up to per-Brief, per-project, per-month.
- Replay reproducibility improves. Combined with the existing prompt versioning, a Run can be re-described from `(prompt_version, telemetry_records)`.
- Live diagnosis. A stuck Run that has been heartbeating for 20 minutes can be inspected — what is the most recent Telemetry Record?
- First-party. Anthropic maintains the format; Major carries no parser fork debt.
- Primitive boundary respected: per-event observations land in Telemetry, summary metrics on the Run row, and the existing `run-ended` Event keeps its lifecycle authority.

### Negative

- **Storage growth.** Stream-json telemetry will be the largest source of `major.telemetry_records` volume; a typical Run might write 50+ rows. Mitigated by a future retention ADR (follow-on).
- **Parser fragility.** The stream-json format is upstream-defined; an Anthropic format change can break the parser. Mitigated by the "telemetry parse failure does not abort the Run" guardrail.
- **Secret leakage risk widens.** More text from Tachikoma stdout lands in the database. Mitigated by sanitizer-on-every-write; if a leak happens, the rotation runbook (`docs/failure-modes.md` § 14) applies.
- **Sequence-counter contention.** Each per-event write performs a transactional `UPDATE … RETURNING` on the Run row. The cost is one row update per event; for a 50-event Run that is 50 small transactions. Negligible against an LLM call, but non-zero and worth noting.
- **No cap means a worst-case Run can write a lot.** Acceptable for v1 because the Tachikoma's own `--max-turns` and wall-clock timeout already bound execution. Revisit if observation says otherwise.

### Follow-on work

- Update `SPEC.md` to document the stream-json shape Major depends on (a snapshot — if Anthropic changes the format, the SPEC moves with the parser).
- Reinforce in `docs/CONTEXT.md` the Event-vs-Telemetry distinction this ADR rests on, citing this ADR as the canonical example of why the boundary is load-bearing.
- Update `.claude/rules/functions/edge-functions.md` to add the per-event idempotency-key shape under the Idempotency section.
- Brief Detail UI: render the most recent N `tachikoma-stream-event` records inline, excerpts only.
- Cost-allocation report: weekly token usage per project (downstream of these columns).
- Retention policy ADR for `tachikoma-stream-event` records.
- Calibrate a per-Run cap from observed distributions if the unbounded shape becomes a real cost.

### Revisit conditions

- When Anthropic changes the stream-json format. Update parser; SPEC notes the format version; ADR may need a successor if the change is structural.
- When `major.telemetry_records` growth hits a real cost ceiling. Adopt retention before then.
- When a parser bug causes a Run to fail despite the "do not abort" guardrail (would mean the guardrail itself is broken). Postmortem and fix.
- When the unbounded per-Run write count produces a single Run that is materially expensive. Calibrate a cap from the observed distribution at that point.

## References

- `docs/CONTEXT.md` — Event vs. Telemetry Record definitions; the boundary this ADR rests on.
- `.claude/rules/functions/edge-functions.md` — Idempotency-key discipline and Run Finalization Transaction shape.
- `.claude/rules/shell/sandbox-discipline.md` § "Never Log Secrets" — sanitizer applies to every Telemetry write.
- ADR 005 — Tachikoma command observability (shares the `major.telemetry_records` write path).
- `shell/tachikoma.ts` — Tachikoma invocation; the `--output-format stream-json` flag flip lands here.
