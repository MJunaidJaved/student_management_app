-- 010_substitution_cancellation.sql
--
-- Not pre-listed in docs/schema-proposals.md; genuinely required by Section 2
-- (Teacher substitutions), approved by the client's standing instruction to
-- make necessary, backward-compatible migrations rather than block on them.
--
-- `substitutions` has no way to record that one was called off: the only
-- options without this migration are a hard DELETE (loses who cancelled it,
-- when, and why — no audit trail) or leaving a cancelled substitution looking
-- active forever. Both are wrong. These columns are nullable with no default,
-- so every existing row is "not cancelled" and no existing query or row is
-- affected.

-- Up Migration

ALTER TABLE substitutions
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by bigint REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN substitutions.cancelled_at IS
  'When this substitution was called off. NULL means it is still in effect.';
COMMENT ON COLUMN substitutions.cancelled_by IS
  'Who cancelled it. NULL while not cancelled.';

-- Down Migration

ALTER TABLE substitutions
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by;
