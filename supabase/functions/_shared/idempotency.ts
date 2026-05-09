// supabase/functions/_shared/idempotency.ts
//
// Per-spec, every Event insert (and most retryable writes) carries an
// idempotency key derived from a fixed tuple. The format is:
//
//     <work_item_id>:<event_type>:<source_actor>:<source_delivery_id>
//
// where `source_delivery_id` is whatever uniquely identifies the source of
// the action — a GitHub delivery id, a runner-generated UUID, a change
// operation id, etc. Callers compose the components; this helper stringifies
// them consistently.
//
// `events.idempotency_key` is a UNIQUE column, so re-inserting with the same
// key fails cleanly — the caller's "ON CONFLICT DO NOTHING" / "upsert" path
// covers replay safety.

export function deriveIdempotencyKey(
  workItemId: number | bigint | null,
  eventType: string,
  sourceActor: string,
  sourceDeliveryId: string,
): string {
  const itemPart = workItemId === null ? "null" : String(workItemId);
  return `${itemPart}:${eventType}:${sourceActor}:${sourceDeliveryId}`;
}
