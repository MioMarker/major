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
  Brief,
  BriefArtifact,
  BriefArtifactPayload,
  BriefClassification,
  BriefContentRevision,
  BriefRelationship,
  BriefStatus,
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
  Shell,
  ShellMetadata,
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
} from './types';

// ────────────────────────────────────────────────────────────────────
// Enum unions: ensure each variant is assignable.
// ────────────────────────────────────────────────────────────────────

const _bs: BriefStatus[] = [
  'ready-for-triage',
  'needs-info',
  'ready-for-agent',
  'agent-running',
  'ready-for-review',
  'ready-for-human',
  'done',
  'wontfix',
];

const _bc: BriefClassification[] = ['bug-fix', 'feature', 'refactor', 'docs', 'parent', 'epic'];
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
  'create-brief',
  'add-content-revision',
  'set-classifications',
  'add-relationship',
  'set-parent-review-requirement',
  'record-git-branch',
  'set-ready-state',
  'set-queue-rank',
  'transition-brief',
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
const _ak: ActorKind[] = ['human', 'agent', 'shell', 'integration', 'major'];
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

const _bf: Brief = {
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
  sourceIssueRepo: 'MioMarker/healthbite',
  sourceIssueNumber: 42,
  currentRevisionId: null,
  createdAt: '2026-05-09T00:00:00Z',
  updatedAt: '2026-05-09T00:00:00Z',
};

const _rev: BriefContentRevision = {
  id: 1,
  briefId: 1,
  revisionNumber: 1,
  contentMd: '# PRD',
  authorActor: 'human:jonathan',
  reason: null,
  createdAt: '2026-05-09T00:00:00Z',
};

const _rel: BriefRelationship = {
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

const _sh: Shell = {
  id: 'shell-A',
  heartbeatAt: '2026-05-09T00:00:00Z',
  startedAt: '2026-05-09T00:00:00Z',
  stoppedAt: null,
  metadata: { containerId: 'abc', imageTag: 'major-shell:1.0', host: 'mac' },
};
const _shm: ShellMetadata = _sh.metadata;

const _run: Run = {
  id: 1,
  briefId: 1,
  purpose: 'execute',
  outcome: 'running',
  cancellationReason: null,
  shellId: 'shell-A',
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
  claimAuthority: ['shell'],
  produceAuthority: ['shell', 'agent'],
  reviewAuthority: ['shell', 'agent', 'human'],
  verifyRequired: ['tsc-noemit', 'tests'],
  acceptanceAuthority: ['human'],
  description: null,
};

const _ba: BriefArtifact = {
  id: 1,
  briefId: 1,
  runId: 1,
  artifactType: 'git-change',
  externalRef: 'https://github.com/x/y/pull/1',
  payload: { baseSha: 'aaa', headSha: 'bbb', prNumber: 1 },
  createdAt: '2026-05-09T00:00:00Z',
};
const _bap: BriefArtifactPayload = _ba.payload;

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
  operationType: 'transition-brief',
  payload: { type: 'transition-brief', briefId: 1, to: 'ready-for-agent' },
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
    case 'create-brief':
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
    case 'transition-brief':
      return p.to;
  }
}
const _opResult: string = _narrowTriageOp(_tco.payload);
const _resRef: TriageChangeOperationResultRef = { table: 'major.briefs', id: 1 };

const _atr: AutoTriageRequest = {
  id: 1,
  briefId: 1,
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
  briefId: 1,
  runId: 1,
  type: 'run-started',
  actor: 'shell:shell-A',
  payload: { kind: 'run-started', runId: 1, purpose: 'execute' },
  idempotencyKey: 'bf:1:ev:run-started:run:1',
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
  briefId: 1,
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
  _bs,
  _bc,
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
  _bf,
  _rev,
  _rel,
  _sh,
  _shm,
  _run,
  _logRef,
  _atc,
  _ba,
  _bap,
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
