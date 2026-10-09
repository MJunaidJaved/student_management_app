-- 009_staff_separation.sql
--
-- Not pre-listed in docs/schema-proposals.md; approved directly by the client
-- in this session's instructions ("if these fields are necessary for a
-- complete staff lifecycle, implement them using a proper, backward-compatible
-- migration"). Module 7 (04-modules-1-to-7.md) specifies deactivation "with
-- date and reason"; `staff` had neither column, so that part of the lifecycle
-- could not be recorded durably at all.
--
-- Both columns are nullable with no default: every existing row is active and
-- has neither a separation date nor a reason, and that is a valid state, not a
-- gap to backfill. Adding a nullable column to a table that already has rows
-- is backward compatible — no existing row or query is affected.

-- Up Migration

ALTER TABLE staff
  ADD COLUMN separation_date date,
  ADD COLUMN separation_reason text;

COMMENT ON COLUMN staff.separation_date IS
  'Date of resignation or termination. NULL while active.';
COMMENT ON COLUMN staff.separation_reason IS
  'Free-text reason recorded at resignation or termination. NULL while active.';

-- Down Migration

ALTER TABLE staff
  DROP COLUMN IF EXISTS separation_date,
  DROP COLUMN IF EXISTS separation_reason;
