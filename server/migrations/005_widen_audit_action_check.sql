-- 005_widen_audit_action_check.sql
--
-- Proposal 1 in docs/schema-proposals.md, approved.
--
-- audit_logs.action allowed only six values: insert, update, delete, login,
-- logout, login_failed. Part 6.5 requires lockouts, password changes and
-- password resets to be recorded as well, and none of those fitted, so Phase 2
-- mapped them onto the nearest permitted value and put the real name in
-- new_values->>'event'. That lost nothing but made "show me every password
-- change" a JSON predicate instead of an indexed equality.
--
-- Only widens what is accepted, so no existing row can violate it.
--
-- The application keeps writing new_values->>'event' as well, because rows
-- already written under the old mapping can only be read that way. The mapping
-- table in modules/auth/auth.repository.ts now maps these events to themselves.

-- Up Migration

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;

ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action = ANY (ARRAY[
    -- Written by the audit_row() trigger on data changes.
    'insert', 'update', 'delete',
    -- Authentication events (Part 6.5).
    'login', 'logout', 'login_failed',
    'account_locked', 'account_unlocked',
    'password_changed', 'password_reset_requested', 'password_reset_completed',
    'refresh_token_reuse',
    -- Authorization denials, so repeated attempts are queryable (Part 7).
    'permission_denied'
  ]));

-- Filtering the log by action is the common case once the values are
-- meaningful; the existing index set has nothing on it.
CREATE INDEX IF NOT EXISTS audit_logs_action_created_idx
  ON audit_logs (action, created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS audit_logs_action_created_idx;

-- Rows using the widened values must be folded back before the narrower
-- constraint can be restored, or this migration cannot be reversed at all.
UPDATE audit_logs SET action = 'login_failed'
 WHERE action IN ('account_locked', 'refresh_token_reuse', 'permission_denied');
UPDATE audit_logs SET action = 'update'
 WHERE action IN ('account_unlocked', 'password_changed',
                  'password_reset_requested', 'password_reset_completed');

ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action = ANY (ARRAY['insert','update','delete','login','logout','login_failed']));
