-- tests/rpc/helpers.sql
-- Shared setup helpers for pgTAP suites. Each test file BEGIN;s its own
-- transaction (for rollback isolation) and may call these helpers inline.
-- Included via \ir helpers.sql from each test file.

-- Ensure pgTAP extension is loaded.
create extension if not exists pgtap;

-- ─────────────────────────────────────────────────────────────────
-- make_shell — insert a minimal major.shells row for test use.
-- ─────────────────────────────────────────────────────────────────
create or replace function _test.make_shell(p_id text default 'test-shell-a')
returns text language sql as $$
  insert into major.shells (id, heartbeat_at, started_at)
  values (p_id, now(), now())
  on conflict (id) do update set heartbeat_at = now()
  returning id;
$$;

-- ─────────────────────────────────────────────────────────────────
-- make_brief — insert a minimal brief in ready-for-agent status.
-- Returns the new brief id.
-- ─────────────────────────────────────────────────────────────────
create or replace function _test.make_brief(
  p_status text default 'ready-for-agent',
  p_repo   text default 'MioMarker/healthbite'
)
returns bigint language plpgsql as $$
declare
  v_brief_id bigint;
  v_rev_id   bigint;
begin
  insert into major.briefs (status, classifications, expected_artifact_type,
    expected_paths, git_repository_ref, base_branch)
  values (p_status, array['bug-fix'], 'git-change', array['src/foo.ts'], p_repo, 'dev')
  returning id into v_brief_id;

  insert into major.brief_content_revisions (brief_id, revision_number, content_md, author_actor)
  values (v_brief_id, 1, '# Test Brief', 'human:test')
  returning id into v_rev_id;

  update major.briefs set current_revision_id = v_rev_id where id = v_brief_id;

  return v_brief_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────
-- make_running_run — claim a brief and return (run_id, brief_id).
-- ─────────────────────────────────────────────────────────────────
create or replace function _test.make_running_run(
  p_shell_id text default 'test-shell-a',
  p_idem     text default null
)
returns table (run_id bigint, brief_id bigint) language plpgsql as $$
declare
  v_brief_id bigint;
begin
  v_brief_id := _test.make_brief();
  perform _test.make_shell(p_shell_id);
  return query
    select r.run_id, r.brief_id
    from major.claim_next_brief(p_shell_id, v_brief_id, 5, 'execute', p_idem) r;
end;
$$;
