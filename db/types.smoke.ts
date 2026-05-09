// Compile-only smoke test for db/types.ts.
// Imports each exported type and exercises it in a no-op assertion. If
// `tsc --noEmit --strict` succeeds against this file, the type module is
// internally consistent.

import type {
  ActorKind,
  ActorString,
  ArtifactType,
  ArtifactTypeContract,
  AutoTriageRequest,
  AutoTriageRequestStatus,
  Event,
  EventPayload,
  EventType,
  KnownEventType,
  KnownTelemetryObservation,
  ParentReviewRequirement,
  PathBlockerConfig,
  PathBlockerReason,
  PullRequestStatus,
  RelationshipType,
  Run,
  RunCancellationReason,
  RunLogArtifactRef,
  RunOutcome,
  RunPurpose,
  RunnerInstance,
  RunnerInstanceMetadata,
  TelemetryObservationType,
  TelemetryRecord,
  TriageChangeOperation,
  TriageChangeOperationPayload,
  TriageChangeOperationResultRef,
  TriageChangeOperationStatus,
  TriageChangeOperationType,
  TriageChangeSet,
  TriageChangeSetDecision,
  TriageSession,
  TriageSessionStatus,
  TriageTranscriptMessage,
  VerificationOutcome,
  VerificationRequirednessSource,
  VerificationResult,
  VerificationResultPayload,
  WorkItem,
  WorkItemArtifact,
  WorkItemArtifactPayload,
  WorkItemClassification,
  WorkItemContentRevision,
  WorkItemRelationship,
  WorkItemStatus,
} from './types';

// ────────────────────────────────────────────────────────────────────
// Enum unions: ensure each variant is assignable.
// ────────────────────────────────────────────────────────────────────

const _wis: WorkItemStatus[] = [
  'ready-for-triage',
  'needs-info',
  'ready-for-agent',
  'agent-running',
  'ready-for-review',
  'ready-for-human',
  'done',
  'wontfix',
];

const _wic: WorkItemClassification[] = ['bug-fix', 'feature', 'refactor', 'docs', 'parent', 'epic'];
const _at: ArtifactType[] = ['git-change', 'triage-change-set'];
const _prs: PullRequestStatus[] = ['absent', 'open', 'merged', 'closed'];
const _rt: RelationshipType[] = ['parent-child', 'blocks'];
const _prr: ParentReviewRequirement[] = ['required', 'optional', 'excluded'];
const _rp: RunPurpose[] = ['execute', 'review', 'triage', 'repair'];
const _ro: RunOutcome[] = ['running', 'succeeded', 'failed', 'cancelled'];
const _rcr: RunCancellationReason[] = [
  'human-cancellation',
  'system-cancellation',
  'lease-expired',
  'repair-acquisition',
];
const _vo: VerificationOutcome[] = ['pass', 'fail', 'skipped'];
const _vrs: VerificationRequirednessSource[] = [
  'artifact-type-policy',
  'ready-for-agent-content',
  'human-override',
  'automated-acceptance-policy',
];
const _tss: TriageSessionStatus[] = ['open', 'closed'];
const _tcsd: TriageChangeSetDecision[] = ['proposed', 'accepted', 'rejected', 'superseded'];
const _tcot: TriageChangeOperationType[] = [
  'create-item',
  'add-content-revision',
  'set-classifications',
  'add-relationship',
  'set-parent-review-requirement',
  'record-git-branch',
  'set-ready-state',
  'set-queue-rank',
  'transition-work-item',
];
const _tcos: TriageChangeOperationStatus[] = [
  'proposed',
  'accepted',
  'rejected',
  'applied',
  'failed',
  'skipped',
  'blocked',
];
const _atrs: AutoTriageRequestStatus[] = [
  'requested',
  'running',
  'completed',
  'failed',
  'cancelled',
  'superseded',
];
const _ak: ActorKind[] = ['human', 'agent', 'runner', 'integration', 'major'];
const _actor: ActorString = 'human:jonathan';
const _ket: KnownEventType = 'run-started';
const _et: EventType = 'something-new';
const _kto: KnownTelemetryObservation = 'failed-claim-attempt';
const _to: TelemetryObservationType = 'unknown-thing';

// ────────────────────────────────────────────────────────────────────
// Row literals — hand-construct one of each to verify the shape.
// ────────────────────────────────────────────────────────────────────

const _ts: TriageSession = {
  id: 1,
  initiatorActor: 'human:jonathan',
  status: 'open',
  transcript: [{ role: 'user', content: 'hi', ts: '2026-05-09T00:00:00Z' }],
  draftPrd: null,
  createdAt: '2026-05-09T00:00:00Z',
  updatedAt: new Date(),
};

const _wi: WorkItem = {
  id: 1,
  status: 'ready-for-triage',
  classifications: ['feature'],
  expectedArtifactType: 'git-change',
  expectedPaths: ['src/foo/**'],
  gitRepositoryRef: 'MioMarker/healthbite',
  gitBranch: null,
  baseBranch: 'dev',
  prStatus: 'absent',
  prUrl: null,
  queueRank: 100,
  priorityClass: null,
  placementReason: null,
  sourceSessionId: 1,
  currentRevisionId: null,
  createdAt: '2026-05-09T00:00:00Z',
  updatedAt: '2026-05-09T00:00:00Z',
};

const _rev: WorkItemContentRevision = {
  id: 1,
  workItemId: 1,
  revisionNumber: 1,
  contentMd: '# PRD',
  authorActor: 'human:jonathan',
  reason: null,
  createdAt: '2026-05-09T00:00:00Z',
};

const _rel: WorkItemRelationship = {
  id: 1,
  parentId: 1,
  childId: 2,
  type: 'parent-child',
  parentReviewRequirement: 'required',
  excludedReason: null,
  excludedByActor: null,
  excludedRevisionId: null,
  createdAt: '2026-05-09T00:00:00Z',
};

const _ri: RunnerInstance = {
  id: 'runner-A',
  heartbeatAt: '2026-05-09T00:00:00Z',
  startedAt: '2026-05-09T00:00:00Z',
  stoppedAt: null,
  metadata: { containerId: 'abc', imageTag: 'major-runner:1.0', host: 'mac' },
};
const _rim: RunnerInstanceMetadata = _ri.metadata;

const _run: Run = {
  id: 1,
  workItemId: 1,
  purpose: 'execute',
  outcome: 'running',
  cancellationReason: null,
  runnerId: 'runner-A',
  startedAgainstRevisionId: 1,
  claimedAt: '2026-05-09T00:00:00Z',
  leaseExpiresAt: '2026-05-09T01:00:00Z',
  heartbeatAt: '2026-05-09T00:00:00Z',
  sandboxRef: '/work',
  logArtifactRefs: [{ kind: 'sandbox-stdout', uri: 's3://x/y' }],
  inspectedRunId: null,
  startedAt: '2026-05-09T00:00:00Z',
  endedAt: null,
};
const _logRef: RunLogArtifactRef = _run.logArtifactRefs[0];

const _atc: ArtifactTypeContract = {
  artifactType: 'git-change',
  claimAuthority: ['runner'],
  produceAuthority: ['runner', 'agent'],
  reviewAuthority: ['runner', 'agent', 'human'],
  verifyRequired: ['tsc-noemit', 'tests'],
  acceptanceAuthority: ['human'],
  description: null,
};

const _wia: WorkItemArtifact = {
  id: 1,
  workItemId: 1,
  runId: 1,
  artifactType: 'git-change',
  externalRef: 'https://github.com/x/y/pull/1',
  payload: { baseSha: 'aaa', headSha: 'bbb', prNumber: 1 },
  createdAt: '2026-05-09T00:00:00Z',
};
const _wiap: WorkItemArtifactPayload = _wia.payload;

const _vr: VerificationResult = {
  id: 1,
  runId: 1,
  checkName: 'tsc-noemit',
  outcome: 'pass',
  required: true,
  requirednessSource: 'artifact-type-policy',
  payload: { outputSnippet: 'OK', durationMs: 1234 },
  createdAt: '2026-05-09T00:00:00Z',
};
const _vrp: VerificationResultPayload = _vr.payload;

const _tcs: TriageChangeSet = {
  id: 1,
  triageSessionId: 1,
  autoTriageRunId: null,
  decision: 'proposed',
  decisionActor: null,
  decidedAt: null,
  summary: 'Add foo',
  needsHumanApply: false,
  blockerReasons: [],
  createdAt: '2026-05-09T00:00:00Z',
};
const _pbr: PathBlockerReason = {
  rule: 'glob-intersection',
  matchedGlob: 'eval/**',
  matchedPath: 'eval/foo.ts',
};

const _tco: TriageChangeOperation = {
  id: 1,
  changeSetId: 1,
  operationType: 'transition-work-item',
  payload: { type: 'transition-work-item', workItemId: 1, to: 'ready-for-agent' },
  status: 'proposed',
  idempotencyKey: 'tcs:1:op:0',
  appliedActor: null,
  appliedAt: null,
  resultingRecordRef: null,
  sequenceIndex: 0,
  createdAt: '2026-05-09T00:00:00Z',
};

// Exercise discriminated union narrowing on the operation payload.
function _narrowTriageOp(p: TriageChangeOperationPayload): string {
  switch (p.type) {
    case 'create-item':
      return p.contentMd;
    case 'add-content-revision':
      return p.contentMd;
    case 'set-classifications':
      return p.classifications.join(',');
    case 'add-relationship':
      return p.relationship;
    case 'set-parent-review-requirement':
      return p.parentReviewRequirement;
    case 'record-git-branch':
      return p.gitBranch;
    case 'set-ready-state':
      return p.expectedArtifactType;
    case 'set-queue-rank':
      return String(p.queueRank);
    case 'transition-work-item':
      return p.to;
  }
}
const _opResult: string = _narrowTriageOp(_tco.payload);
const _resRef: TriageChangeOperationResultRef = { table: 'major.work_items', id: 1 };

const _atr: AutoTriageRequest = {
  id: 1,
  workItemId: 1,
  status: 'requested',
  requestedActor: 'human:jonathan',
  requestedRevisionId: null,
  resultingRunId: null,
  notes: null,
  createdAt: '2026-05-09T00:00:00Z',
  updatedAt: '2026-05-09T00:00:00Z',
};

const _ev: Event = {
  id: 1,
  workItemId: 1,
  runId: 1,
  type: 'run-started',
  actor: 'runner:runner-A',
  payload: { kind: 'run-started', runId: 1, purpose: 'execute' },
  idempotencyKey: 'wi:1:ev:run-started:run:1',
  createdAt: '2026-05-09T00:00:00Z',
};

// Exercise narrowing on a discriminated event payload.
function _eventKind(p: EventPayload): string {
  if ('kind' in p && typeof p.kind === 'string') return p.kind;
  return 'unknown';
}
const _evKind: string = _eventKind(_ev.payload);

const _tr: TelemetryRecord = {
  id: 1,
  workItemId: 1,
  runId: 1,
  observationType: 'heartbeat-lapse',
  payload: { lastHeartbeatAt: '2026-05-09T00:00:00Z' },
  createdAt: '2026-05-09T00:00:00Z',
};

const _pbc: PathBlockerConfig = {
  id: 1,
  protectedGlobs: ['supabase/functions/chat-with-ai/**', 'eval/**'],
  massRerankThreshold: 5,
  updatedAt: '2026-05-09T00:00:00Z',
  updatedBy: 'human:jonathan',
};

const _ttm: TriageTranscriptMessage = _ts.transcript[0];

// Reference everything to silence "unused" diagnostics in noUnusedLocals mode.
export const _refs = {
  _wis,
  _wic,
  _at,
  _prs,
  _rt,
  _prr,
  _rp,
  _ro,
  _rcr,
  _vo,
  _vrs,
  _tss,
  _tcsd,
  _tcot,
  _tcos,
  _atrs,
  _ak,
  _actor,
  _ket,
  _et,
  _kto,
  _to,
  _ts,
  _wi,
  _rev,
  _rel,
  _ri,
  _rim,
  _run,
  _logRef,
  _atc,
  _wia,
  _wiap,
  _vr,
  _vrp,
  _tcs,
  _pbr,
  _tco,
  _opResult,
  _resRef,
  _atr,
  _ev,
  _evKind,
  _tr,
  _pbc,
  _ttm,
};
