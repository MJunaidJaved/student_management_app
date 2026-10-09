-- 011_exam_payroll_audit.sql
--
-- Required by Section 4 (Exams, Results & Payroll): "record who finalized or
-- published results and when" and "record the responsible user and the
-- promotion operation for audit purposes". `exams`, `exam_schedules`,
-- `report_cards`, `student_promotions` and `payroll_runs` have no audit
-- trigger yet (unlike `marks`, `payslips` and `staff_salaries`, which already
-- carry one) even though every write already runs through `transaction()`,
-- which sets `app.current_user_id` on every connection. Adding the same
-- `audit_row()` trigger these already-covered tables use is the existing
-- mechanism, not a new column — it captures who changed what and when (via
-- `audit_logs.old_values`/`new_values`) for every INSERT/UPDATE, including an
-- exam's draft -> published -> locked transitions and a report card's
-- corrections or re-publications.
--
-- No new columns, no new tables. Nothing existing is affected: a BEFORE
-- trigger already runs `set_updated_at()` on each of these; this adds an
-- AFTER trigger alongside it, exactly as every other audited table already
-- has both.

-- Up Migration

CREATE TRIGGER trg_audit_exams AFTER INSERT OR UPDATE ON public.exams FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_exam_schedules AFTER INSERT OR UPDATE OR DELETE ON public.exam_schedules FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_report_cards AFTER INSERT OR UPDATE ON public.report_cards FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_student_promotions AFTER INSERT OR UPDATE ON public.student_promotions FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_payroll_runs AFTER INSERT OR UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Down Migration

DROP TRIGGER IF EXISTS trg_audit_exams ON public.exams;
DROP TRIGGER IF EXISTS trg_audit_exam_schedules ON public.exam_schedules;
DROP TRIGGER IF EXISTS trg_audit_report_cards ON public.report_cards;
DROP TRIGGER IF EXISTS trg_audit_student_promotions ON public.student_promotions;
DROP TRIGGER IF EXISTS trg_audit_payroll_runs ON public.payroll_runs;
