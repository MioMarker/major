-- 20260525000001_add_brief_paths_blocked.sql
--
-- Adds the self-contained server-side path-blocker helper that
-- apply_change_set (20260513000000 / 20260525000000) calls in its
-- set-ready-state and transition-brief branches. The function originally
-- shipped in 20260512000001_rpc_v2_stream_b.sql, but the Stream B migration
-- set was never applied to the dev project, so apply_change_set fails with
-- "function major.brief_paths_blocked(bigint) does not exist".
--
-- This pulls ONLY brief_paths_blocked forward (verbatim from 20260512000001),
-- not the rest of Stream B. It is self-contained: it reads
-- major.briefs.expected_paths and major.path_blocker_config.protected_globs,
-- both of which already exist on dev. The remaining Stream A/B drift is
-- tracked separately for a deliberate reconciliation.
--
-- F-04 / Plan 001 Stream B task 3, Hard Rule 5 defense-in-depth. The precise
-- check lives in TS at supabase/functions/_shared/path_blocker.ts; this SQL
-- helper uses a coarse LIKE translation (`**` / `*` -> `%`) sufficient for the
-- current protected glob vocabulary. If protected_globs ever contain literal
-- `_` or `?`, expand the translation accordingly.

set search_path = major, public;

begin;

create or replace function major.brief_paths_blocked(p_brief_id bigint)
returns boolean
language sql stable as $$
  select exists (
    select 1
    from major.briefs b
    cross join lateral unnest(coalesce(b.expected_paths, array[]::text[])) as ep
    cross join lateral (
      select protected_globs from major.path_blocker_config where id = 1
    ) as cfg
    cross join lateral unnest(cfg.protected_globs) as pg
    where b.id = p_brief_id
      and ep like replace(replace(pg, '**', '%'), '*', '%')
  );
$$;

grant execute on function major.brief_paths_blocked(bigint) to service_role;
grant execute on function major.brief_paths_blocked(bigint) to authenticated;

commit;
