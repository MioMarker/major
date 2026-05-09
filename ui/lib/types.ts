// Major UI types — derived from db/0001_initial_schema.sql.
// In Phase 3 these should be re-exported from `@/db/types` once that exists;
// for now they are duplicated here so the UI typechecks standalone.

export type WorkItemStatus =
  | "ready-for-triage"
  | "needs-info"
  | "ready-for-agent"
  | "agent-running"
  | "ready-for-review"
  | "ready-for-human"
  | "done"
  | "wontfix";

export type WorkItemClassification =
  | "bug-fix"
  | "feature"
  | "refactor"
  | "docs"
  | "parent"
  | "epic";

export type ArtifactType = "git-change" | "triage-change-set";

export type PrStatus = "absent" | "open" | "merged" | "closed";

export type ParentReviewRequirement = "required" | "optional" | "excluded";

export type RelationshipType = "parent-child" | "blocks";

export type RunPurpose = "execute" | "review" | "triage" | "repair";

export type RunOutcome = "running" | "succeeded" | "failed" | "cancelled";

export type VerificationOutcome = "pass" | "fail" | "skipped";

export type TriageSessionStatus = "open" | "closed";

export type ChangeSetDecision = "proposed" | "accepted" | "rejected" | "superseded";

export type ChangeOperationType =
  | "create-item"
  | "add-content-revision"
  | "set-classifications"
  | "add-relationship"
  | "set-parent-review-requirement"
  | "record-git-branch"
  | "set-ready-state"
  | "set-queue-rank"
  | "transition-work-item";

export type ChangeOperationStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "applied"
  | "failed"
  | "skipped"
  | "blocked";

export interface WorkItem {
  id: number;
  status: WorkItemStatus;
  classifications: WorkItemClassification[];
  expected_artifact_type: ArtifactType | null;
  expected_paths: string[];
  git_repository_ref: string | null;
  git_branch: string | null;
  base_branch: string;
  pr_status: PrStatus;
  pr_url: string | null;
  queue_rank: number | null;
  priority_class: string | null;
  placement_reason: string | null;
  source_session_id: number | null;
  current_revision_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemContentRevision {
  id: number;
  work_item_id: number;
  revision_number: number;
  content_md: string;
  author_actor: string;
  reason: string | null;
  created_at: string;
}

export interface WorkItemRelationship {
  id: number;
  parent_id: number;
  child_id: number;
  type: RelationshipType;
  parent_review_requirement: ParentReviewRequirement;
  excluded_reason: string | null;
  excluded_by_actor: string | null;
  created_at: string;
}

export interface Run {
  id: number;
  work_item_id: number;
  purpose: RunPurpose;
  outcome: RunOutcome;
  cancellation_reason: string | null;
  runner_id: string | null;
  started_against_revision_id: number | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  sandbox_ref: string | null;
  inspected_run_id: number | null;
  started_at: string;
  ended_at: string | null;
}

export interface VerificationResult {
  id: number;
  run_id: number;
  check_name: string;
  outcome: VerificationOutcome;
  required: boolean;
  requiredness_source: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WorkItemArtifact {
  id: number;
  work_item_id: number;
  run_id: number | null;
  artifact_type: ArtifactType;
  external_ref: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type EventType =
  | "item-created"
  | "status-transitioned"
  | "run-started"
  | "run-ended"
  | "accepted"
  | "rejected"
  | "human-handoff"
  | "relationship-added"
  | "content-revision-added"
  | "artifact-produced"
  | "queue-rank-set"
  | string;

export interface MajorEvent {
  id: number;
  work_item_id: number | null;
  run_id: number | null;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  created_at: string;
}

export interface TriageMessage {
  role: "human" | "agent" | "system";
  content: string;
  ts: string;
}

export interface TriageSession {
  id: number;
  initiator_actor: string;
  status: TriageSessionStatus;
  transcript: TriageMessage[];
  draft_prd: string | null;
  created_at: string;
  updated_at: string;
}

export interface TriageChangeOperation {
  id: number;
  change_set_id: number;
  operation_type: ChangeOperationType;
  payload: Record<string, unknown>;
  status: ChangeOperationStatus;
  idempotency_key: string;
  applied_actor: string | null;
  applied_at: string | null;
  resulting_record_ref: Record<string, unknown> | null;
  sequence_index: number;
  created_at: string;
}

export interface TriageChangeSet {
  id: number;
  triage_session_id: number | null;
  auto_triage_run_id: number | null;
  decision: ChangeSetDecision;
  decision_actor: string | null;
  decided_at: string | null;
  summary: string | null;
  needs_human_apply: boolean;
  blocker_reasons: Array<{ glob: string; matched: string }>;
  created_at: string;
  operations?: TriageChangeOperation[];
}

export interface PathBlockerConfig {
  protected_globs: string[];
  mass_rerank_threshold: number;
  updated_at: string;
  updated_by: string;
}

export interface ItemDetail extends WorkItem {
  current_revision: WorkItemContentRevision | null;
  revisions: WorkItemContentRevision[];
  events: MajorEvent[];
  runs: Run[];
  verification_results: VerificationResult[];
  artifacts: WorkItemArtifact[];
  relationships: Array<
    WorkItemRelationship & { related_item: Pick<WorkItem, "id" | "status"> }
  >;
}

export interface SettingsPayload {
  protected_globs: string[];
  mass_rerank_threshold: number;
  runner_pool_size_hint: number;
  auto_triage_enabled: boolean;
  auto_triage_on_new_items: boolean;
}
