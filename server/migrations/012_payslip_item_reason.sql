-- 012_payslip_item_reason.sql
--
-- Required by Section 4 (Payroll): "Support approved manual adjustments with
-- a recorded reason and responsible user." `payslips` already carries a
-- responsible user for free — `trg_audit_payslips` (baseline) attaches
-- whoever is running the current transaction to every INSERT/UPDATE, the
-- same mechanism migration 011 used for exams — but `payslip_items` has no
-- `reason` column and no audit trigger of its own, so there is nowhere to
-- record *why* a specific earning or deduction line was added.
--
-- `reason` is nullable with no default: a payslip_item created by normal
-- payroll generation (the recurring basic-salary line) has no "reason" to
-- give, only a manual adjustment does, so every existing or auto-generated
-- row is unaffected. The audit trigger is the same `audit_row()` every other
-- audited table already uses.

-- Up Migration

ALTER TABLE payslip_items
  ADD COLUMN reason text;

COMMENT ON COLUMN payslip_items.reason IS
  'Why this line was added, for a manual adjustment. NULL for an ordinary generated line (e.g. basic salary).';

CREATE TRIGGER trg_audit_payslip_items AFTER INSERT OR UPDATE OR DELETE ON public.payslip_items FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Down Migration

DROP TRIGGER IF EXISTS trg_audit_payslip_items ON public.payslip_items;

ALTER TABLE payslip_items
  DROP COLUMN IF EXISTS reason;
