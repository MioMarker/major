-- Major v1 — initial schema
-- All tables under the `major` schema. Foreign keys keep relational integrity.
-- Single Active Run Rule enforced via partial unique index.

create schema if not exists major;

-- ═══════════════════════════════════════════════════════════════
-- TRIAGE SESSIONS — durable conversation surface for grilling work
-- ═══════════════════════════════════════════════════════════════

create table major.triage_sessions (
  id              bigserial primary key,
  initiator_actor text not null,                          -- 'human:jonathan'
  status          text not null default 'open' check (status in ('open', 'closed')),
  transcript      jsonb not null default '[]',            -- [{role, content, ts}, ...]
  draft_prd       text,                                   -- evolving PRD draft
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_triage_sessions_status on major.triage_sessions (status);

-- ═══════════════════════════════════════════════════════════════
-- WORK ITEMS — core lifecycle entity
-- ═══════════════════════════════════════════════════════════════

create table major.work_items (
  id                       bigserial primary key,
  status                   text not null default 'ready-for-triage'
                              check (status in ('ready-for-triage', 'needs-info', 'ready-for-agent',
                                                'agent-running', 'ready-for-review', 'ready-for-human',
                                                'done', 'wontfix')),
  classifications          text[] not null default '{}',  -- ['bug-fix','feature','refactor','docs','parent','epic']
  expected_artifact_type   text check (expected_artifact_type in ('git-change', 'triage-change-set')),
  expected_paths           text[] not null default '{}',
  git_repository_ref       text,                          -- 'MioMarker/healthbite' | 'MioMarker/healix'
  git_branch               text,                          -- 'major/work-item-<id>' (set after provisioning)
  base_branch              text default 'dev',
  pr_status                text default 'absent' check (pr_status in ('absent', 'open', 'merged', 'closed')),
  pr_url                   text,
  queue_rank               integer,
  priority_class           text,
  placement_reason         text,
  source_session_id        bigint references major.triage_sessions(id),
  current_revision_id      bigint,                        -- FK added after content_revisions table
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index idx_work_items_status_queue on major.work_items (status, queue_rank) where status = 'ready-for-agent';
create index idx_work_items_repo on major.work_items (git_repository_ref);
create index idx_work_items_branch on major.work_items (git_branch);

-- ═══════════════════════════════════════════════════════════════
-- WORK ITEM CONTENT REVISIONS — Run executes against specific revision
-- ═══════════════════════════════════════════════════════════════

create table major.work_item_content_revisions (
  id              bigserial primary key,
  work_item_id    bigint not null references major.work_items(id) on delete cascade,
  revision_number integer not null,
  content_md      text not null,
  author_actor    text not null,
  reason          text,                                   -- e.g., 'requested-changes-from-auto-triage'
  created_at      timestamptz not null default now(),
  unique (work_item_id, revision_number)
);

alter table major.work_items
  add constraint fk_work_items_current_revision
  foreign key (current_revision_id) references major.work_item_content_revisions(id);

create index idx_revisions_work_item on major.work_item_content_revisions (work_item_id);

-- ═══════════════════════════════════════════════════════════════
-- WORK ITEM RELATIONSHIPS — parent/child and blocks/blocked-by
-- ═══════════════════════════════════════════════════════════════

create table major.work_item_relationships (
  id                            bigserial primary key,
  parent_id                     bigint not null references major.work_items(id) on delete cascade,
  child_id                      bigint not null references major.work_items(id) on delete cascade,
  type                          text not null check (type in ('parent-child', 'blocks')),
  parent_review_requirement     text default 'required'
                                  check (parent_review_requirement in ('required', 'optional', 'excluded')),
  excluded_reason               text,
  excluded_by_actor             text,
  excluded_revision_id          bigint references major.work_item_content_revisions(id),
  created_at                    timestamptz not null default now(),
  unique (parent_id, child_id, type),
  check (parent_id <> child_id)
);

create index idx_relationships_parent on major.work_item_relationships (parent_id);
create index idx_relationships_child on major.work_item_relationships (child_id);

-- ═══════════════════════════════════════════════════════════════
-- RUNNER INSTANCES — Docker container registry with heartbeat
-- ═══════════════════════════════════════════════════════════════

create table major.runner_instances (
  id            text primary key,                          -- 'runner-A','runner-B'
  heartbeat_at  timestamptz not null default now(),
  started_at    timestamptz not null default now(),
  stopped_at    timestamptz,
  metadata      jsonb not null default '{}'                -- { container_id, image_tag, host }
);

create index idx_runner_instances_heartbeat on major.runner_instances (heartbeat_at) where stopped_at is null;

-- ═══════════════════════════════════════════════════════════════
-- RUNS — bounded execution attempts; one row per Run
-- ═══════════════════════════════════════════════════════════════

create table major.runs (
  id                            bigserial primary key,
  work_item_id                  bigint not null references major.work_items(id) on delete cascade,
  purpose                       text not null check (purpose in ('execute', 'review', 'triage', 'repair')),
  outcome                       text not null default 'running'
                                  check (outcome in ('running', 'succeeded', 'failed', 'cancelled')),
  cancellation_reason           text,                     -- 'human-cancellation','system-cancellation','lease-expired','repair-acquisition'
  runner_id                     text references major.runner_instances(id),
  started_against_revision_id   bigint references major.work_item_content_revisions(id),
  claimed_at                    timestamptz,
  lease_expires_at              timestamptz,
  heartbeat_at                  timestamptz,
  sandbox_ref                   text,                     -- container working dir, sandbox id
  log_artifact_refs             jsonb default '[]',
  inspected_run_id              bigint references major.runs(id),  -- only set when purpose=repair
  started_at                    timestamptz not null default now(),
  ended_at                      timestamptz
);

-- Single Active Run Rule
create unique index idx_runs_single_active on major.runs (work_item_id) where outcome = 'running';
create index idx_runs_lease on major.runs (lease_expires_at) where outcome = 'running';
create index idx_runs_runner on major.runs (runner_id);

-- ═══════════════════════════════════════════════════════════════
-- ARTIFACT TYPE CONTRACTS — what can be produced and how
-- ═══════════════════════════════════════════════════════════════

create table major.artifact_type_contracts (
  artifact_type        text primary key,
  claim_authority      text[] not null,
  produce_authority    text[] not null,
  review_authority     text[] not null,
  verify_required      text[] not null default '{}',
  acceptance_authority text[] not null,
  description          text
);

insert into major.artifact_type_contracts
  (artifact_type, claim_authority, produce_authority, review_authority, verify_required, acceptance_authority, description)
values
  ('git-change',
   '{runner}', '{runner,agent}', '{runner,agent,human}',
   '{tsc-noemit,tests}', '{human}',
   'Code change reviewed via Pull Request; sandbox tsc + tests required; eval gate advisory for chat/eval paths'),
  ('triage-change-set',
   '{runner}', '{runner,agent}', '{human}',
   '{}', '{human}',
   'Triage proposal awaiting human apply');

-- ═══════════════════════════════════════════════════════════════
-- WORK ITEM ARTIFACTS — durable outputs of Runs
-- ═══════════════════════════════════════════════════════════════

create table major.work_item_artifacts (
  id              bigserial primary key,
  work_item_id    bigint not null references major.work_items(id) on delete cascade,
  run_id          bigint references major.runs(id),
  artifact_type   text not null references major.artifact_type_contracts(artifact_type),
  external_ref    text,                                   -- PR URL, branch sha range, change_set id
  payload         jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create index idx_artifacts_work_item on major.work_item_artifacts (work_item_id);
create index idx_artifacts_run on major.work_item_artifacts (run_id);

-- ═══════════════════════════════════════════════════════════════
-- VERIFICATION RESULTS — per-Run check outcomes
-- ═══════════════════════════════════════════════════════════════

create table major.verification_results (
  id                  bigserial primary key,
  run_id              bigint not null references major.runs(id) on delete cascade,
  check_name          text not null,                      -- 'tsc-noemit','tests','eval-gate','reviewer-tachikoma'
  outcome             text not null check (outcome in ('pass', 'fail', 'skipped')),
  required            boolean not null default false,
  requiredness_source text check (requiredness_source in ('artifact-type-policy', 'ready-for-agent-content',
                                                          'human-override', 'automated-acceptance-policy')),
  payload             jsonb not null default '{}',        -- output snippet, link to artifact
  created_at          timestamptz not null default now(),
  unique (run_id, check_name)
);

create index idx_verification_run on major.verification_results (run_id);

-- ═══════════════════════════════════════════════════════════════
-- TRIAGE CHANGE SETS — proposals from Sessions or Auto Triage Runs
-- ═══════════════════════════════════════════════════════════════

create table major.triage_change_sets (
  id                  bigserial primary key,
  triage_session_id   bigint references major.triage_sessions(id),
  auto_triage_run_id  bigint references major.runs(id),
  decision            text not null default 'proposed'
                        check (decision in ('proposed', 'accepted', 'rejected', 'superseded')),
  decision_actor      text,
  decided_at          timestamptz,
  summary             text,
  needs_human_apply   boolean not null default false,    -- set by path-blocker
  blocker_reasons     jsonb default '[]',                -- which path-blocker rules tripped
  created_at          timestamptz not null default now(),
  check (triage_session_id is not null or auto_triage_run_id is not null)
);

create index idx_change_sets_decision on major.triage_change_sets (decision);

-- ═══════════════════════════════════════════════════════════════
-- TRIAGE CHANGE OPERATIONS — individual mutations within a Change Set
-- ═══════════════════════════════════════════════════════════════

create table major.triage_change_operations (
  id                    bigserial primary key,
  change_set_id         bigint not null references major.triage_change_sets(id) on delete cascade,
  operation_type        text not null check (operation_type in (
                          'create-item',
                          'add-content-revision',
                          'set-classifications',
                          'add-relationship',
                          'set-parent-review-requirement',
                          'record-git-branch',
                          'set-ready-state',
                          'set-queue-rank',
                          'transition-work-item'
                        )),
  payload               jsonb not null,
  status                text not null default 'proposed'
                          check (status in ('proposed', 'accepted', 'rejected', 'applied', 'failed', 'skipped', 'blocked')),
  idempotency_key       text not null unique,
  applied_actor         text,
  applied_at            timestamptz,
  resulting_record_ref  jsonb,                            -- pointer to created/modified row
  sequence_index        integer not null,                 -- order within change set
  created_at            timestamptz not null default now()
);

create index idx_change_ops_change_set on major.triage_change_operations (change_set_id, sequence_index);
create index idx_change_ops_status on major.triage_change_operations (status);

-- ═══════════════════════════════════════════════════════════════
-- AUTO TRIAGE REQUESTS — scheduling primitive
-- ═══════════════════════════════════════════════════════════════

create table major.auto_triage_requests (
  id                      bigserial primary key,
  work_item_id            bigint not null references major.work_items(id) on delete cascade,
  status                  text not null default 'requested'
                            check (status in ('requested', 'running', 'completed', 'failed', 'cancelled', 'superseded')),
  requested_actor         text not null,
  requested_revision_id   bigint references major.work_item_content_revisions(id),
  resulting_run_id        bigint references major.runs(id),
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- One non-terminal request per Work Item
create unique index idx_atr_one_nonterminal on major.auto_triage_requests (work_item_id)
  where status in ('requested', 'running');

-- ═══════════════════════════════════════════════════════════════
-- EVENTS — lifecycle-changing actions; idempotent
-- ═══════════════════════════════════════════════════════════════

create table major.events (
  id                bigserial primary key,
  work_item_id      bigint references major.work_items(id) on delete cascade,
  run_id            bigint references major.runs(id),
  type              text not null,                        -- 'item-created','status-transitioned','run-started','run-ended','accepted','rejected','human-handoff','relationship-added','content-revision-added','artifact-produced','queue-rank-set','...'
  actor             text not null,                        -- 'human:jonathan','runner:runner-A','agent:tachikoma','integration:github','major:auto-triage','major:reaper'
  payload           jsonb not null default '{}',
  idempotency_key   text not null,
  created_at        timestamptz not null default now(),
  unique (idempotency_key)
);

create index idx_events_work_item on major.events (work_item_id, created_at desc);
create index idx_events_run on major.events (run_id) where run_id is not null;
create index idx_events_type on major.events (type, created_at desc);

-- ═══════════════════════════════════════════════════════════════
-- TELEMETRY RECORDS — operational observations; non-lifecycle
-- ═══════════════════════════════════════════════════════════════

create table major.telemetry_records (
  id                bigserial primary key,
  work_item_id      bigint references major.work_items(id) on delete cascade,
  run_id            bigint references major.runs(id),
  observation_type  text not null,                        -- 'failed-claim-attempt','heartbeat-lapse','external-system-error','retry-attempt','repair-inspection-trigger'
  payload           jsonb not null default '{}',
  created_at        timestamptz not null default now()
);

create index idx_telemetry_work_item on major.telemetry_records (work_item_id, created_at desc);
create index idx_telemetry_observation on major.telemetry_records (observation_type, created_at desc);

-- ═══════════════════════════════════════════════════════════════
-- PATH BLOCKER CONFIG — editable list of protected globs
-- ═══════════════════════════════════════════════════════════════

create table major.path_blocker_config (
  id                          integer primary key default 1 check (id = 1),  -- singleton
  protected_globs             text[] not null,
  mass_rerank_threshold       integer not null default 5,                     -- > N rerank ops triggers human apply
  updated_at                  timestamptz not null default now(),
  updated_by                  text not null
);

insert into major.path_blocker_config (id, protected_globs, mass_rerank_threshold, updated_by)
values (1,
        array[
          'supabase/functions/chat-with-ai/**',
          'eval/**',
          'supabase/migrations/**',
          '.claude/rules/**',
          'app.config.ts'
        ],
        5,
        'system:bootstrap');

-- ═══════════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGERS
-- ═══════════════════════════════════════════════════════════════

create or replace function major.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_work_items_updated_at before update on major.work_items
  for each row execute function major.set_updated_at();
create trigger trg_triage_sessions_updated_at before update on major.triage_sessions
  for each row execute function major.set_updated_at();
create trigger trg_auto_triage_requests_updated_at before update on major.auto_triage_requests
  for each row execute function major.set_updated_at();
