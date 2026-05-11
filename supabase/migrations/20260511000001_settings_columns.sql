-- 20260511000001_settings_columns.sql
--
-- Extends major.path_blocker_config (the operator settings singleton) with
-- the three columns that major-get-settings / major-update-settings expose
-- to the UI. All additive; existing rows get the same defaults the mock uses.

BEGIN;

ALTER TABLE major.path_blocker_config
  ADD COLUMN IF NOT EXISTS auto_triage_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_triage_on_new_briefs boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shell_pool_size_hint      integer NOT NULL DEFAULT 2;

COMMIT;
