-- 20260511000003_settings_ai_provider.sql
--
-- Extends major.path_blocker_config with an ai_provider column so the
-- Settings UI can choose which LLM provider major-auto-triage-sessions
-- uses at runtime. Defaults to 'openai' (backward-compatible).

BEGIN;

ALTER TABLE major.path_blocker_config
  ADD COLUMN IF NOT EXISTS ai_provider text NOT NULL DEFAULT 'openai'
    CHECK (ai_provider IN ('anthropic', 'openai'));

COMMIT;
