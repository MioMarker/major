-- 20260511000005_settings_ai_provider.sql
--
-- Extends major.path_blocker_config with an ai_provider column so the
-- Settings UI can choose which LLM provider major-auto-triage-sessions
-- uses at runtime. Defaults to 'openai' (backward-compatible).
--
-- Renumbered from 20260511000003 to resolve a timestamp collision with
-- 20260511000003_add_merge_blocked_status.sql and
-- 20260511000003_triage_sessions_auto_triage_claim.sql.

BEGIN;

ALTER TABLE major.path_blocker_config
  ADD COLUMN IF NOT EXISTS ai_provider text NOT NULL DEFAULT 'openai'
    CHECK (ai_provider IN ('anthropic', 'openai'));

COMMIT;
