-- Major v1 — change base_branch default from 'develop' to 'dev'
--
-- Motivation: HealthBite + Healix already use 'dev' (not 'develop') as the
-- integration branch. Major was originally specced for 'develop' but the
-- consumer repos use 'dev'. Aligning Major's default with reality avoids
-- surprises when create-item operations omit base_branch.
--
-- Recorded as ADR-003 (renamed file 003-dev-as-integration-branch.md).
-- Existing rows are not back-filled here — they were created before this
-- correction landed; v1 didn't have any such rows yet at apply time.

set search_path = major, public;

alter table major.work_items
  alter column base_branch set default 'dev';
