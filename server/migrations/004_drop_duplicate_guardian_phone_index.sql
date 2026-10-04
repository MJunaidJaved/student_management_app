-- 004_drop_duplicate_guardian_phone_index.sql
--
-- Removes an index that 003 should not have created.
--
-- 003 added `guardians_phone_idx` as a partial B-tree on (phone) WHERE
-- deleted_at IS NULL. The schema already had `ix_guardians_phone`, a plain
-- B-tree on the same column, which 003 did not check for.
--
-- Two indexes on one column is a cost paid on every write to `guardians` for
-- no read benefit. The partial one is marginally smaller, but the pre-existing
-- full index serves both the soft-delete-filtered lookup and any query without
-- that filter, so it is the one worth keeping.
--
-- The addition made here is removed rather than the original: dropping an index
-- that came with the schema is not covered by the approved additions, and there
-- is no measurement yet to justify it. Reverting my own is unambiguous.
--
-- Note for later: `students` and `staff` phone indexes were NOT duplicates —
-- neither table had one — so those stay.

-- Up Migration

DROP INDEX IF EXISTS guardians_phone_idx;

-- Down Migration

CREATE INDEX IF NOT EXISTS guardians_phone_idx ON guardians (phone)
  WHERE deleted_at IS NULL;
