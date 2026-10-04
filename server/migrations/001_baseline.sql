-- 001_baseline.sql
--
-- The schema as it stood when the backend was built, reconstructed from
-- the live database. This is the starting point: every later change is a
-- numbered migration on top of it.
--
-- On the existing database this migration is recorded as already applied
-- rather than run (see scripts/mark-baseline-applied.ts). It is executed
-- only when building a fresh database, such as a test one.
--
-- Generated 2026-09-30T08:11:36.223Z

-- Up Migration

-- Extensions
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- Human-readable number sequences (admission no, receipt no, and so on)
CREATE SEQUENCE IF NOT EXISTS public.seq_admission_no AS bigint START WITH 1000 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_application_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_certificate_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_employee_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_invoice_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_po_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_receipt_no AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.seq_voucher_no AS bigint START WITH 1 INCREMENT BY 1;

-- Trigger and helper functions
CREATE OR REPLACE FUNCTION public.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_user BIGINT := NULLIF(current_setting('app.current_user_id', true), '')::BIGINT;
BEGIN
  INSERT INTO audit_logs(user_id, action, table_name, record_id, old_values, new_values)
  VALUES (v_user, lower(TG_OP), TG_TABLE_NAME,
          COALESCE((to_jsonb(NEW)->>'id'), (to_jsonb(OLD)->>'id')),
          CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END; $function$;

CREATE OR REPLACE FUNCTION public.check_allocation_total()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_alloc NUMERIC(12,2); v_amt NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(amount),0) INTO v_alloc FROM payment_allocations WHERE payment_id = NEW.payment_id;
  SELECT amount INTO v_amt FROM payments WHERE id = NEW.payment_id;
  IF v_alloc <> v_amt THEN
    RAISE EXCEPTION 'Allocations (%) must equal payment amount (%)', v_alloc, v_amt;
  END IF;
  RETURN NULL;
END; $function$;

CREATE OR REPLACE FUNCTION public.check_vehicle_capacity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_cap INT; v_used INT;
BEGIN
  SELECT v.capacity INTO v_cap
    FROM route_stops rs JOIN routes r ON r.id = rs.route_id JOIN vehicles v ON v.id = r.vehicle_id
   WHERE rs.id = NEW.route_stop_id;
  IF v_cap IS NULL THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO v_used
    FROM student_transport st
    JOIN route_stops s1 ON s1.id = st.route_stop_id
    JOIN route_stops s2 ON s2.route_id = s1.route_id
   WHERE st.end_date IS NULL AND s2.id = NEW.route_stop_id AND st.id <> COALESCE(NEW.id, 0);
  IF NEW.end_date IS NULL AND v_used >= v_cap THEN RAISE EXCEPTION 'Vehicle capacity (%) exceeded', v_cap; END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.check_voucher_balance()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE d NUMERIC; c NUMERIC; v_id BIGINT;
BEGIN
  v_id := COALESCE(NEW.id, OLD.id);
  IF NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0) INTO d, c
      FROM voucher_entries WHERE voucher_id = v_id;
    IF d = 0 OR d <> c THEN RAISE EXCEPTION 'Voucher % unbalanced: debit %, credit %', v_id, d, c; END IF;
  END IF;
  RETURN NULL;
END; $function$;

CREATE OR REPLACE FUNCTION public.guard_closed_year()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_closed BOOLEAN;
BEGIN
  SELECT is_closed INTO v_closed FROM academic_years
   WHERE id = COALESCE(NEW.academic_year_id, OLD.academic_year_id);
  IF v_closed THEN RAISE EXCEPTION 'Academic year is closed'; END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;

CREATE OR REPLACE FUNCTION public.guard_marks()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_total NUMERIC; v_status TEXT;
BEGIN
  SELECT es.total_marks, e.status INTO v_total, v_status
    FROM exam_schedules es JOIN exams e ON e.id = es.exam_id WHERE es.id = NEW.exam_schedule_id;
  IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained > v_total THEN
    RAISE EXCEPTION 'Marks (%) exceed total marks (%)', NEW.marks_obtained, v_total;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.is_locked OR v_status = 'locked') THEN
    RAISE EXCEPTION 'Marks are locked';
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.guard_payments()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Payments cannot be deleted; reverse them instead'; END IF;
  IF OLD.status = 'reversed' THEN RAISE EXCEPTION 'Reversed payment cannot be modified'; END IF;
  IF NEW.amount <> OLD.amount OR NEW.receipt_no <> OLD.receipt_no OR NEW.method <> OLD.method THEN
    RAISE EXCEPTION 'Payment amount/receipt/method cannot be edited; reverse and re-enter';
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.guard_payslips()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status TEXT; v_run BIGINT;
BEGIN
  v_run := COALESCE(NEW.payroll_run_id, OLD.payroll_run_id);
  SELECT status INTO v_status FROM payroll_runs WHERE id = v_run;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'Payroll run is % and cannot be changed', v_status; END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;

CREATE OR REPLACE FUNCTION public.guard_posted_voucher()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_status TEXT; v_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'vouchers' THEN
    IF OLD.status = 'posted' THEN RAISE EXCEPTION 'Posted voucher is immutable'; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_id := COALESCE(NEW.voucher_id, OLD.voucher_id);
  SELECT status INTO v_status FROM vouchers WHERE id = v_id;
  IF v_status = 'posted' THEN RAISE EXCEPTION 'Entries of a posted voucher are immutable'; END IF;
  RETURN COALESCE(NEW, OLD);
END; $function$;

CREATE OR REPLACE FUNCTION public.prevent_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME; END; $function$;

CREATE OR REPLACE FUNCTION public.recompute_invoice(p_invoice bigint)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE v_paid NUMERIC(12,2); v_total NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(a.amount),0) INTO v_paid
    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
   WHERE a.invoice_id = p_invoice AND p.status = 'valid';
  SELECT total INTO v_total FROM fee_invoices WHERE id = p_invoice FOR UPDATE;
  UPDATE fee_invoices
     SET paid_total = v_paid,
         status = CASE WHEN status = 'cancelled' THEN 'cancelled'
                       WHEN v_paid = 0 THEN 'unpaid'
                       WHEN v_paid >= v_total THEN 'paid'
                       ELSE 'partial' END
   WHERE id = p_invoice;
END; $function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.trg_alloc_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN PERFORM recompute_invoice(NEW.invoice_id); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.trg_payment_reversed()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r record;
BEGIN
  IF NEW.status = 'reversed' AND OLD.status = 'valid' THEN
    FOR r IN SELECT invoice_id FROM payment_allocations WHERE payment_id = NEW.id LOOP
      PERFORM recompute_invoice(r.invoice_id);
    END LOOP;
  END IF;
  RETURN NEW;
END; $function$;

-- Tables
CREATE TABLE IF NOT EXISTS public.academic_years (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  is_current boolean DEFAULT false NOT NULL,
  is_closed boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.account_heads (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  parent_id bigint,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.admission_applications (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  application_no text DEFAULT ('APP-'::text || lpad((nextval('seq_application_no'::regclass))::text, 6, '0'::text)) NOT NULL,
  applicant_name text NOT NULL,
  dob date NOT NULL,
  gender text,
  guardian_name text NOT NULL,
  guardian_phone text NOT NULL,
  applied_class_id bigint NOT NULL,
  status text DEFAULT 'enquiry'::text NOT NULL,
  student_id bigint,
  remarks text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint,
  action text NOT NULL,
  table_name text,
  record_id text,
  old_values jsonb,
  new_values jsonb,
  ip_address inet,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  bank_name text NOT NULL,
  account_title text NOT NULL,
  account_no text NOT NULL,
  opening_balance numeric(14,2) DEFAULT 0 NOT NULL,
  account_head_id bigint,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.book_categories (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.book_issues (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  book_id bigint NOT NULL,
  borrower_type text NOT NULL,
  student_id bigint,
  staff_id bigint,
  issue_date date DEFAULT CURRENT_DATE NOT NULL,
  due_date date NOT NULL,
  return_date date,
  status text DEFAULT 'issued'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.books (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  accession_no text NOT NULL,
  isbn text,
  title text NOT NULL,
  author text,
  category_id bigint,
  copies_total integer DEFAULT 1 NOT NULL,
  shelf_location text,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.budgets (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  account_head_id bigint NOT NULL,
  amount numeric(14,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.class_subjects (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  class_id bigint NOT NULL,
  subject_id bigint NOT NULL,
  is_mandatory boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.classes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  level_order integer NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.departments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.designations (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  department_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.discounts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  value numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.drivers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  full_name text NOT NULL,
  license_no text NOT NULL,
  license_expiry date NOT NULL,
  phone text NOT NULL,
  national_id text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.exam_schedules (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  exam_id bigint NOT NULL,
  class_id bigint NOT NULL,
  subject_id bigint NOT NULL,
  exam_date date NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  room_id bigint,
  total_marks numeric(6,2) NOT NULL,
  passing_marks numeric(6,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.exam_types (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  weightage numeric(5,2),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.exams (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  term_id bigint,
  exam_type_id bigint NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  account_head_id bigint NOT NULL,
  amount numeric(12,2) NOT NULL,
  expense_date date DEFAULT CURRENT_DATE NOT NULL,
  paid_via text NOT NULL,
  bank_account_id bigint,
  description text,
  attachment_path text,
  approved_by bigint,
  voucher_id bigint,
  created_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fee_categories (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  frequency text NOT NULL,
  income_head_id bigint,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fee_invoice_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  invoice_id bigint NOT NULL,
  fee_category_id bigint NOT NULL,
  description text,
  amount numeric(12,2) NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fee_invoices (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  invoice_no text DEFAULT ('INV-'::text || lpad((nextval('seq_invoice_no'::regclass))::text, 8, '0'::text)) NOT NULL,
  enrollment_id bigint NOT NULL,
  billing_period text NOT NULL,
  issue_date date DEFAULT CURRENT_DATE NOT NULL,
  due_date date NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  discount_total numeric(12,2) DEFAULT 0 NOT NULL,
  fine_total numeric(12,2) DEFAULT 0 NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  paid_total numeric(12,2) DEFAULT 0 NOT NULL,
  status text DEFAULT 'unpaid'::text NOT NULL,
  created_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fee_structures (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  class_id bigint NOT NULL,
  fee_category_id bigint NOT NULL,
  amount numeric(12,2) NOT NULL,
  due_day integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.fine_rules (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  grace_days integer DEFAULT 0 NOT NULL,
  fee_category_id bigint,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.grading_scale_ranges (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  grading_scale_id bigint NOT NULL,
  min_percent numeric(5,2) NOT NULL,
  max_percent numeric(5,2) NOT NULL,
  grade text NOT NULL,
  gpa_points numeric(3,2),
  remark text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.grading_scales (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.guardians (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  full_name text NOT NULL,
  national_id text,
  phone text NOT NULL,
  email text,
  occupation text,
  address text,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.installment_plans (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  fee_invoice_id bigint NOT NULL,
  installment_no integer NOT NULL,
  due_date date NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.item_categories (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  category_id bigint NOT NULL,
  unit text DEFAULT 'pcs'::text NOT NULL,
  reorder_level numeric(10,2) DEFAULT 0 NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.leave_requests (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  applicant_type text NOT NULL,
  enrollment_id bigint,
  staff_id bigint,
  leave_type_id bigint NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  reason text,
  status text DEFAULT 'pending'::text NOT NULL,
  decided_by bigint,
  decided_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.leave_types (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  applies_to text NOT NULL,
  days_per_year integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.library_fines (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  book_issue_id bigint NOT NULL,
  amount numeric(10,2) NOT NULL,
  status text DEFAULT 'unpaid'::text NOT NULL,
  payment_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.marks (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  exam_schedule_id bigint NOT NULL,
  enrollment_id bigint NOT NULL,
  marks_obtained numeric(6,2),
  is_absent boolean DEFAULT false NOT NULL,
  entered_by bigint,
  is_locked boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notification_logs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  notification_id bigint NOT NULL,
  user_id bigint,
  guardian_id bigint,
  channel text NOT NULL,
  status text DEFAULT 'queued'::text NOT NULL,
  sent_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  channel text NOT NULL,
  target_type text NOT NULL,
  target_id bigint,
  created_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payment_allocations (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  payment_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  receipt_no text DEFAULT ('RCPT-'::text || lpad((nextval('seq_receipt_no'::regclass))::text, 8, '0'::text)) NOT NULL,
  guardian_id bigint,
  amount numeric(12,2) NOT NULL,
  method text NOT NULL,
  reference_no text,
  bank_account_id bigint,
  paid_at timestamp with time zone DEFAULT now() NOT NULL,
  received_by bigint NOT NULL,
  status text DEFAULT 'valid'::text NOT NULL,
  reversed_by bigint,
  reversed_at timestamp with time zone,
  reversal_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  pay_month integer NOT NULL,
  pay_year integer NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  run_by bigint,
  approved_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payslip_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  payslip_id bigint NOT NULL,
  salary_component_id bigint NOT NULL,
  component_name text NOT NULL,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.payslips (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  payroll_run_id bigint NOT NULL,
  staff_id bigint NOT NULL,
  gross numeric(12,2) NOT NULL,
  total_deductions numeric(12,2) DEFAULT 0 NOT NULL,
  net numeric(12,2) NOT NULL,
  paid_on date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.periods (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  start_time time without time zone NOT NULL,
  end_time time without time zone NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.permissions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  code text NOT NULL,
  module text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.purchase_order_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  po_id bigint NOT NULL,
  item_id bigint NOT NULL,
  quantity numeric(10,2) NOT NULL,
  unit_cost numeric(12,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  po_no text DEFAULT ('PO-'::text || lpad((nextval('seq_po_no'::regclass))::text, 6, '0'::text)) NOT NULL,
  supplier_id bigint NOT NULL,
  order_date date DEFAULT CURRENT_DATE NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  total numeric(14,2) DEFAULT 0 NOT NULL,
  created_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.report_cards (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  exam_id bigint NOT NULL,
  enrollment_id bigint NOT NULL,
  total_marks numeric(8,2) NOT NULL,
  obtained_marks numeric(8,2) NOT NULL,
  percentage numeric(5,2) NOT NULL,
  grade text,
  rank integer,
  remarks text,
  published_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id bigint NOT NULL,
  permission_id bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.roles (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.rooms (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  capacity integer,
  room_type text DEFAULT 'classroom'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.route_stops (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  route_id bigint NOT NULL,
  stop_name text NOT NULL,
  stop_order integer NOT NULL,
  pickup_time time without time zone,
  monthly_fee numeric(10,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.routes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  vehicle_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.salary_components (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  calc_type text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.salary_structures (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.sections (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  class_id bigint NOT NULL,
  name text NOT NULL,
  capacity integer DEFAULT 40 NOT NULL,
  class_teacher_id bigint,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.settings (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  key text NOT NULL,
  value text,
  group_name text DEFAULT 'general'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  employee_no text DEFAULT ('EMP-'::text || lpad((nextval('seq_employee_no'::regclass))::text, 5, '0'::text)) NOT NULL,
  full_name text NOT NULL,
  gender text NOT NULL,
  dob date NOT NULL,
  national_id text,
  phone text NOT NULL,
  email text,
  address text,
  department_id bigint,
  designation_id bigint,
  join_date date NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  photo_path text,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_advances (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  amount numeric(12,2) NOT NULL,
  recovered numeric(12,2) DEFAULT 0 NOT NULL,
  monthly_deduction numeric(12,2) NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  issued_on date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_attendance (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  att_date date NOT NULL,
  check_in time without time zone,
  check_out time without time zone,
  status text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_contracts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  contract_type text NOT NULL,
  start_date date NOT NULL,
  end_date date,
  basic_salary numeric(12,2) NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_documents (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_leave_balances (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  leave_type_id bigint NOT NULL,
  academic_year_id bigint NOT NULL,
  allotted numeric(5,1) NOT NULL,
  used numeric(5,1) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_salaries (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  staff_id bigint NOT NULL,
  salary_structure_id bigint,
  basic_salary numeric(12,2) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  item_id bigint NOT NULL,
  type text NOT NULL,
  quantity numeric(10,2) NOT NULL,
  reference_type text,
  reference_id bigint,
  moved_at timestamp with time zone DEFAULT now() NOT NULL,
  moved_by bigint
);

CREATE TABLE IF NOT EXISTS public.student_attendance (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  enrollment_id bigint NOT NULL,
  att_date date NOT NULL,
  status text NOT NULL,
  marked_by bigint,
  remarks text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_discipline_records (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  enrollment_id bigint NOT NULL,
  incident_date date NOT NULL,
  description text NOT NULL,
  action_taken text,
  reported_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_discounts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  enrollment_id bigint NOT NULL,
  discount_id bigint NOT NULL,
  fee_category_id bigint,
  approved_by bigint,
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_documents (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id bigint NOT NULL,
  doc_type text NOT NULL,
  file_path text NOT NULL,
  uploaded_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_enrollments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id bigint NOT NULL,
  academic_year_id bigint NOT NULL,
  class_id bigint NOT NULL,
  section_id bigint NOT NULL,
  roll_no integer NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  enrolled_on date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_guardians (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id bigint NOT NULL,
  guardian_id bigint NOT NULL,
  relation text NOT NULL,
  is_primary boolean DEFAULT false NOT NULL,
  is_fee_payer boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_health_records (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id bigint NOT NULL,
  allergies text,
  conditions text,
  emergency_contact_name text,
  emergency_contact_phone text,
  doctor_name text,
  recorded_on date DEFAULT CURRENT_DATE NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_leaving_records (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  student_id bigint NOT NULL,
  leaving_date date NOT NULL,
  reason text,
  certificate_no text DEFAULT ('LC-'::text || lpad((nextval('seq_certificate_no'::regclass))::text, 6, '0'::text)) NOT NULL,
  issued_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_promotions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  from_enrollment_id bigint NOT NULL,
  to_enrollment_id bigint,
  action text NOT NULL,
  decided_by bigint,
  decided_on date DEFAULT CURRENT_DATE NOT NULL,
  remarks text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.student_transport (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  enrollment_id bigint NOT NULL,
  route_stop_id bigint NOT NULL,
  start_date date NOT NULL,
  end_date date,
  monthly_fee numeric(10,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.students (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  admission_no text DEFAULT ('ADM-'::text || lpad((nextval('seq_admission_no'::regclass))::text, 6, '0'::text)) NOT NULL,
  first_name text NOT NULL,
  last_name text,
  gender text NOT NULL,
  dob date NOT NULL,
  national_id text,
  religion text,
  blood_group text,
  address text,
  phone text,
  photo_path text,
  admission_date date NOT NULL,
  previous_school text,
  status text DEFAULT 'active'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.subject_teachers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  section_id bigint NOT NULL,
  subject_id bigint NOT NULL,
  staff_id bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.subjects (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text DEFAULT 'core'::text NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.substitutions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  timetable_entry_id bigint NOT NULL,
  sub_date date NOT NULL,
  substitute_staff_id bigint NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.suppliers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  address text,
  tax_no text,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.terms (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.timetable_entries (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  academic_year_id bigint NOT NULL,
  section_id bigint NOT NULL,
  day_of_week integer NOT NULL,
  period_id bigint NOT NULL,
  subject_id bigint NOT NULL,
  staff_id bigint NOT NULL,
  room_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id bigint NOT NULL,
  role_id bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS public.users (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  username text NOT NULL,
  email text,
  phone text,
  password_hash text NOT NULL,
  user_type text NOT NULL,
  staff_id bigint,
  guardian_id bigint,
  student_id bigint,
  is_active boolean DEFAULT true NOT NULL,
  last_login_at timestamp with time zone,
  failed_attempts integer DEFAULT 0 NOT NULL,
  locked_until timestamp with time zone,
  must_change_password boolean DEFAULT true NOT NULL,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.vehicles (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  reg_no text NOT NULL,
  capacity integer NOT NULL,
  driver_id bigint,
  insurance_expiry date,
  fitness_expiry date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.voucher_entries (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  voucher_id bigint NOT NULL,
  account_head_id bigint NOT NULL,
  debit numeric(14,2) DEFAULT 0 NOT NULL,
  credit numeric(14,2) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.vouchers (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  voucher_no text DEFAULT ('V-'::text || lpad((nextval('seq_voucher_no'::regclass))::text, 8, '0'::text)) NOT NULL,
  type text NOT NULL,
  voucher_date date DEFAULT CURRENT_DATE NOT NULL,
  narration text,
  source_type text,
  source_id bigint,
  status text DEFAULT 'draft'::text NOT NULL,
  created_by bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Constraints
ALTER TABLE public.academic_years ADD CONSTRAINT academic_years_pkey PRIMARY KEY (id);
ALTER TABLE public.account_heads ADD CONSTRAINT account_heads_pkey PRIMARY KEY (id);
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.book_categories ADD CONSTRAINT book_categories_pkey PRIMARY KEY (id);
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_pkey PRIMARY KEY (id);
ALTER TABLE public.books ADD CONSTRAINT books_pkey PRIMARY KEY (id);
ALTER TABLE public.budgets ADD CONSTRAINT budgets_pkey PRIMARY KEY (id);
ALTER TABLE public.class_subjects ADD CONSTRAINT class_subjects_pkey PRIMARY KEY (id);
ALTER TABLE public.classes ADD CONSTRAINT classes_pkey PRIMARY KEY (id);
ALTER TABLE public.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE public.designations ADD CONSTRAINT designations_pkey PRIMARY KEY (id);
ALTER TABLE public.discounts ADD CONSTRAINT discounts_pkey PRIMARY KEY (id);
ALTER TABLE public.drivers ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_pkey PRIMARY KEY (id);
ALTER TABLE public.exam_types ADD CONSTRAINT exam_types_pkey PRIMARY KEY (id);
ALTER TABLE public.exams ADD CONSTRAINT exams_pkey PRIMARY KEY (id);
ALTER TABLE public.expenses ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);
ALTER TABLE public.fee_categories ADD CONSTRAINT fee_categories_pkey PRIMARY KEY (id);
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_pkey PRIMARY KEY (id);
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_pkey PRIMARY KEY (id);
ALTER TABLE public.fine_rules ADD CONSTRAINT fine_rules_pkey PRIMARY KEY (id);
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_pkey PRIMARY KEY (id);
ALTER TABLE public.grading_scales ADD CONSTRAINT grading_scales_pkey PRIMARY KEY (id);
ALTER TABLE public.guardians ADD CONSTRAINT guardians_pkey PRIMARY KEY (id);
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_pkey PRIMARY KEY (id);
ALTER TABLE public.item_categories ADD CONSTRAINT item_categories_pkey PRIMARY KEY (id);
ALTER TABLE public.items ADD CONSTRAINT items_pkey PRIMARY KEY (id);
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.leave_types ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_pkey PRIMARY KEY (id);
ALTER TABLE public.marks ADD CONSTRAINT marks_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);
ALTER TABLE public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);
ALTER TABLE public.payslip_items ADD CONSTRAINT payslip_items_pkey PRIMARY KEY (id);
ALTER TABLE public.payslips ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);
ALTER TABLE public.periods ADD CONSTRAINT periods_pkey PRIMARY KEY (id);
ALTER TABLE public.permissions ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_pkey PRIMARY KEY (id);
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
ALTER TABLE public.roles ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
ALTER TABLE public.rooms ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_pkey PRIMARY KEY (id);
ALTER TABLE public.routes ADD CONSTRAINT routes_pkey PRIMARY KEY (id);
ALTER TABLE public.salary_components ADD CONSTRAINT salary_components_pkey PRIMARY KEY (id);
ALTER TABLE public.salary_structures ADD CONSTRAINT salary_structures_pkey PRIMARY KEY (id);
ALTER TABLE public.sections ADD CONSTRAINT sections_pkey PRIMARY KEY (id);
ALTER TABLE public.settings ADD CONSTRAINT settings_pkey PRIMARY KEY (id);
ALTER TABLE public.staff ADD CONSTRAINT staff_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_attendance ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_documents ADD CONSTRAINT staff_documents_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_pkey PRIMARY KEY (id);
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);
ALTER TABLE public.student_attendance ADD CONSTRAINT student_attendance_pkey PRIMARY KEY (id);
ALTER TABLE public.student_discipline_records ADD CONSTRAINT student_discipline_records_pkey PRIMARY KEY (id);
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_pkey PRIMARY KEY (id);
ALTER TABLE public.student_documents ADD CONSTRAINT student_documents_pkey PRIMARY KEY (id);
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_pkey PRIMARY KEY (id);
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_pkey PRIMARY KEY (id);
ALTER TABLE public.student_health_records ADD CONSTRAINT student_health_records_pkey PRIMARY KEY (id);
ALTER TABLE public.student_leaving_records ADD CONSTRAINT student_leaving_records_pkey PRIMARY KEY (id);
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_pkey PRIMARY KEY (id);
ALTER TABLE public.student_transport ADD CONSTRAINT student_transport_pkey PRIMARY KEY (id);
ALTER TABLE public.students ADD CONSTRAINT students_pkey PRIMARY KEY (id);
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_pkey PRIMARY KEY (id);
ALTER TABLE public.subjects ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_pkey PRIMARY KEY (id);
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);
ALTER TABLE public.terms ADD CONSTRAINT terms_pkey PRIMARY KEY (id);
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);
ALTER TABLE public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_pkey PRIMARY KEY (id);
ALTER TABLE public.academic_years ADD CONSTRAINT academic_years_name_key UNIQUE (name);
ALTER TABLE public.account_heads ADD CONSTRAINT account_heads_code_key UNIQUE (code);
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_application_no_key UNIQUE (application_no);
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_student_id_key UNIQUE (student_id);
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_account_no_key UNIQUE (account_no);
ALTER TABLE public.book_categories ADD CONSTRAINT book_categories_name_key UNIQUE (name);
ALTER TABLE public.books ADD CONSTRAINT books_accession_no_key UNIQUE (accession_no);
ALTER TABLE public.budgets ADD CONSTRAINT budgets_academic_year_id_account_head_id_key UNIQUE (academic_year_id, account_head_id);
ALTER TABLE public.class_subjects ADD CONSTRAINT class_subjects_class_id_subject_id_key UNIQUE (class_id, subject_id);
ALTER TABLE public.classes ADD CONSTRAINT classes_level_order_key UNIQUE (level_order);
ALTER TABLE public.classes ADD CONSTRAINT classes_name_key UNIQUE (name);
ALTER TABLE public.departments ADD CONSTRAINT departments_name_key UNIQUE (name);
ALTER TABLE public.designations ADD CONSTRAINT designations_name_key UNIQUE (name);
ALTER TABLE public.discounts ADD CONSTRAINT discounts_name_key UNIQUE (name);
ALTER TABLE public.drivers ADD CONSTRAINT drivers_license_no_key UNIQUE (license_no);
ALTER TABLE public.drivers ADD CONSTRAINT drivers_national_id_key UNIQUE (national_id);
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_exam_id_class_id_subject_id_key UNIQUE (exam_id, class_id, subject_id);
ALTER TABLE public.exam_types ADD CONSTRAINT exam_types_name_key UNIQUE (name);
ALTER TABLE public.exams ADD CONSTRAINT exams_academic_year_id_name_key UNIQUE (academic_year_id, name);
ALTER TABLE public.fee_categories ADD CONSTRAINT fee_categories_name_key UNIQUE (name);
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_enrollment_id_billing_period_key UNIQUE (enrollment_id, billing_period);
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_invoice_no_key UNIQUE (invoice_no);
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_academic_year_id_class_id_fee_category_id_key UNIQUE (academic_year_id, class_id, fee_category_id);
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_grading_scale_id_grade_key UNIQUE (grading_scale_id, grade);
ALTER TABLE public.grading_scales ADD CONSTRAINT grading_scales_name_key UNIQUE (name);
ALTER TABLE public.guardians ADD CONSTRAINT guardians_national_id_key UNIQUE (national_id);
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_fee_invoice_id_installment_no_key UNIQUE (fee_invoice_id, installment_no);
ALTER TABLE public.item_categories ADD CONSTRAINT item_categories_name_key UNIQUE (name);
ALTER TABLE public.items ADD CONSTRAINT items_sku_key UNIQUE (sku);
ALTER TABLE public.leave_types ADD CONSTRAINT leave_types_name_key UNIQUE (name);
ALTER TABLE public.marks ADD CONSTRAINT marks_exam_schedule_id_enrollment_id_key UNIQUE (exam_schedule_id, enrollment_id);
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_payment_id_invoice_id_key UNIQUE (payment_id, invoice_id);
ALTER TABLE public.payments ADD CONSTRAINT payments_receipt_no_key UNIQUE (receipt_no);
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_pay_month_pay_year_key UNIQUE (pay_month, pay_year);
ALTER TABLE public.payslips ADD CONSTRAINT payslips_payroll_run_id_staff_id_key UNIQUE (payroll_run_id, staff_id);
ALTER TABLE public.periods ADD CONSTRAINT periods_sort_order_key UNIQUE (sort_order);
ALTER TABLE public.permissions ADD CONSTRAINT permissions_code_key UNIQUE (code);
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_po_id_item_id_key UNIQUE (po_id, item_id);
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_po_no_key UNIQUE (po_no);
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_exam_id_enrollment_id_key UNIQUE (exam_id, enrollment_id);
ALTER TABLE public.roles ADD CONSTRAINT roles_name_key UNIQUE (name);
ALTER TABLE public.rooms ADD CONSTRAINT rooms_name_key UNIQUE (name);
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_route_id_stop_order_key UNIQUE (route_id, stop_order);
ALTER TABLE public.routes ADD CONSTRAINT routes_name_key UNIQUE (name);
ALTER TABLE public.salary_components ADD CONSTRAINT salary_components_name_key UNIQUE (name);
ALTER TABLE public.salary_structures ADD CONSTRAINT salary_structures_name_key UNIQUE (name);
ALTER TABLE public.sections ADD CONSTRAINT sections_class_id_name_key UNIQUE (class_id, name);
ALTER TABLE public.sections ADD CONSTRAINT sections_id_class_id_key UNIQUE (id, class_id);
ALTER TABLE public.settings ADD CONSTRAINT settings_key_key UNIQUE (key);
ALTER TABLE public.staff ADD CONSTRAINT staff_employee_no_key UNIQUE (employee_no);
ALTER TABLE public.staff ADD CONSTRAINT staff_national_id_key UNIQUE (national_id);
ALTER TABLE public.staff_attendance ADD CONSTRAINT staff_attendance_staff_id_att_date_key UNIQUE (staff_id, att_date);
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_staff_id_leave_type_id_academic_year_i_key UNIQUE (staff_id, leave_type_id, academic_year_id);
ALTER TABLE public.student_attendance ADD CONSTRAINT student_attendance_enrollment_id_att_date_key UNIQUE (enrollment_id, att_date);
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_academic_year_id_section_id_roll_no_key UNIQUE (academic_year_id, section_id, roll_no);
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_student_id_guardian_id_key UNIQUE (student_id, guardian_id);
ALTER TABLE public.student_leaving_records ADD CONSTRAINT student_leaving_records_certificate_no_key UNIQUE (certificate_no);
ALTER TABLE public.student_leaving_records ADD CONSTRAINT student_leaving_records_student_id_key UNIQUE (student_id);
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_from_enrollment_id_key UNIQUE (from_enrollment_id);
ALTER TABLE public.students ADD CONSTRAINT students_admission_no_key UNIQUE (admission_no);
ALTER TABLE public.students ADD CONSTRAINT students_national_id_key UNIQUE (national_id);
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_academic_year_id_section_id_subject_id_key UNIQUE (academic_year_id, section_id, subject_id);
ALTER TABLE public.subjects ADD CONSTRAINT subjects_code_key UNIQUE (code);
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_timetable_entry_id_sub_date_key UNIQUE (timetable_entry_id, sub_date);
ALTER TABLE public.terms ADD CONSTRAINT terms_academic_year_id_name_key UNIQUE (academic_year_id, name);
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_academic_year_id_room_id_day_of_week_peri_key UNIQUE (academic_year_id, room_id, day_of_week, period_id);
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_academic_year_id_section_id_day_of_week_p_key UNIQUE (academic_year_id, section_id, day_of_week, period_id);
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_academic_year_id_staff_id_day_of_week_per_key UNIQUE (academic_year_id, staff_id, day_of_week, period_id);
ALTER TABLE public.users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE public.users ADD CONSTRAINT users_guardian_id_key UNIQUE (guardian_id);
ALTER TABLE public.users ADD CONSTRAINT users_staff_id_key UNIQUE (staff_id);
ALTER TABLE public.users ADD CONSTRAINT users_student_id_key UNIQUE (student_id);
ALTER TABLE public.users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_reg_no_key UNIQUE (reg_no);
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_voucher_no_key UNIQUE (voucher_no);
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_grading_scale_id_numrange_excl EXCLUDE USING gist (grading_scale_id WITH =, numrange(min_percent, max_percent, '[]'::text) WITH &&);
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_staff_id_daterange_excl EXCLUDE USING gist (staff_id WITH =, daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]'::text) WITH &&) WHERE ((status = 'active'::text));
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_staff_id_daterange_excl EXCLUDE USING gist (staff_id WITH =, daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[)'::text) WITH &&);
ALTER TABLE public.academic_years ADD CONSTRAINT academic_years_check CHECK ((end_date > start_date));
ALTER TABLE public.account_heads ADD CONSTRAINT account_heads_type_check CHECK ((type = ANY (ARRAY['asset'::text, 'liability'::text, 'income'::text, 'expense'::text, 'equity'::text])));
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])));
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_status_check CHECK ((status = ANY (ARRAY['enquiry'::text, 'applied'::text, 'test'::text, 'accepted'::text, 'rejected'::text, 'enrolled'::text])));
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check CHECK ((action = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text, 'login'::text, 'logout'::text, 'login_failed'::text])));
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_borrower_type_check CHECK ((borrower_type = ANY (ARRAY['student'::text, 'staff'::text])));
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_check CHECK ((due_date >= issue_date));
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_check1 CHECK (((return_date IS NULL) OR (return_date >= issue_date)));
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_check2 CHECK ((((borrower_type = 'student'::text) AND (student_id IS NOT NULL) AND (staff_id IS NULL)) OR ((borrower_type = 'staff'::text) AND (staff_id IS NOT NULL) AND (student_id IS NULL))));
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'returned'::text, 'lost'::text])));
ALTER TABLE public.books ADD CONSTRAINT books_copies_total_check CHECK ((copies_total >= 0));
ALTER TABLE public.budgets ADD CONSTRAINT budgets_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.discounts ADD CONSTRAINT discounts_check CHECK (((type <> 'percent'::text) OR (value <= (100)::numeric)));
ALTER TABLE public.discounts ADD CONSTRAINT discounts_type_check CHECK ((type = ANY (ARRAY['percent'::text, 'fixed'::text])));
ALTER TABLE public.discounts ADD CONSTRAINT discounts_value_check CHECK ((value >= (0)::numeric));
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_check CHECK ((end_time > start_time));
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_check1 CHECK ((passing_marks <= total_marks));
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_passing_marks_check CHECK ((passing_marks >= (0)::numeric));
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_total_marks_check CHECK ((total_marks > (0)::numeric));
ALTER TABLE public.exam_types ADD CONSTRAINT exam_types_weightage_check CHECK (((weightage >= (0)::numeric) AND (weightage <= (100)::numeric)));
ALTER TABLE public.exams ADD CONSTRAINT exams_check CHECK ((end_date >= start_date));
ALTER TABLE public.exams ADD CONSTRAINT exams_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'locked'::text])));
ALTER TABLE public.expenses ADD CONSTRAINT expenses_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.expenses ADD CONSTRAINT expenses_check CHECK (((paid_via = 'cash'::text) OR (bank_account_id IS NOT NULL)));
ALTER TABLE public.expenses ADD CONSTRAINT expenses_paid_via_check CHECK ((paid_via = ANY (ARRAY['cash'::text, 'bank'::text, 'cheque'::text, 'online'::text])));
ALTER TABLE public.fee_categories ADD CONSTRAINT fee_categories_frequency_check CHECK ((frequency = ANY (ARRAY['monthly'::text, 'termly'::text, 'yearly'::text, 'one_time'::text])));
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_check CHECK ((discount_amount <= amount));
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_discount_amount_check CHECK ((discount_amount >= (0)::numeric));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_billing_period_check CHECK ((billing_period ~ '^\d{4}-(0[1-9]|1[0-2])$|^[A-Za-z0-9_-]+$'::text));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_check CHECK ((due_date >= issue_date));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_check1 CHECK ((total = ((subtotal - discount_total) + fine_total)));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_check2 CHECK ((paid_total <= total));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_discount_total_check CHECK ((discount_total >= (0)::numeric));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_fine_total_check CHECK ((fine_total >= (0)::numeric));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_paid_total_check CHECK ((paid_total >= (0)::numeric));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'partial'::text, 'paid'::text, 'cancelled'::text])));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_subtotal_check CHECK ((subtotal >= (0)::numeric));
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_total_check CHECK ((total >= (0)::numeric));
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_due_day_check CHECK (((due_day >= 1) AND (due_day <= 31)));
ALTER TABLE public.fine_rules ADD CONSTRAINT fine_rules_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.fine_rules ADD CONSTRAINT fine_rules_grace_days_check CHECK ((grace_days >= 0));
ALTER TABLE public.fine_rules ADD CONSTRAINT fine_rules_type_check CHECK ((type = ANY (ARRAY['per_day'::text, 'flat'::text, 'percent'::text])));
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_check CHECK ((max_percent >= min_percent));
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_gpa_points_check CHECK ((gpa_points >= (0)::numeric));
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_max_percent_check CHECK (((max_percent >= (0)::numeric) AND (max_percent <= (100)::numeric)));
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_min_percent_check CHECK (((min_percent >= (0)::numeric) AND (min_percent <= (100)::numeric)));
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_installment_no_check CHECK ((installment_no > 0));
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'overdue'::text])));
ALTER TABLE public.items ADD CONSTRAINT items_reorder_level_check CHECK ((reorder_level >= (0)::numeric));
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_applicant_type_check CHECK ((applicant_type = ANY (ARRAY['student'::text, 'staff'::text])));
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_check CHECK ((to_date >= from_date));
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_check1 CHECK ((((applicant_type = 'student'::text) AND (enrollment_id IS NOT NULL) AND (staff_id IS NULL)) OR ((applicant_type = 'staff'::text) AND (staff_id IS NOT NULL) AND (enrollment_id IS NULL))));
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));
ALTER TABLE public.leave_types ADD CONSTRAINT leave_types_applies_to_check CHECK ((applies_to = ANY (ARRAY['student'::text, 'staff'::text, 'both'::text])));
ALTER TABLE public.leave_types ADD CONSTRAINT leave_types_days_per_year_check CHECK ((days_per_year >= 0));
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_check CHECK (((status <> 'paid'::text) OR (payment_id IS NOT NULL)));
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'waived'::text])));
ALTER TABLE public.marks ADD CONSTRAINT marks_check CHECK (((NOT is_absent) OR (marks_obtained IS NULL)));
ALTER TABLE public.marks ADD CONSTRAINT marks_marks_obtained_check CHECK ((marks_obtained >= (0)::numeric));
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'whatsapp'::text, 'email'::text, 'in_app'::text])));
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_check CHECK (((user_id IS NOT NULL) OR (guardian_id IS NOT NULL)));
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text, 'read'::text])));
ALTER TABLE public.notifications ADD CONSTRAINT notifications_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'whatsapp'::text, 'email'::text, 'in_app'::text])));
ALTER TABLE public.notifications ADD CONSTRAINT notifications_target_type_check CHECK ((target_type = ANY (ARRAY['all'::text, 'class'::text, 'section'::text, 'student'::text, 'guardian'::text, 'staff'::text])));
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.payments ADD CONSTRAINT payments_check CHECK (((method <> ALL (ARRAY['bank'::text, 'cheque'::text])) OR (bank_account_id IS NOT NULL)));
ALTER TABLE public.payments ADD CONSTRAINT payments_check1 CHECK ((((status = 'reversed'::text) AND (reversed_by IS NOT NULL) AND (reversed_at IS NOT NULL) AND (reversal_reason IS NOT NULL)) OR ((status = 'valid'::text) AND (reversed_by IS NULL) AND (reversed_at IS NULL))));
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'bank'::text, 'online'::text, 'cheque'::text])));
ALTER TABLE public.payments ADD CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'reversed'::text])));
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_pay_month_check CHECK (((pay_month >= 1) AND (pay_month <= 12)));
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_pay_year_check CHECK (((pay_year >= 2000) AND (pay_year <= 2100)));
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'paid'::text])));
ALTER TABLE public.payslip_items ADD CONSTRAINT payslip_items_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.payslip_items ADD CONSTRAINT payslip_items_type_check CHECK ((type = ANY (ARRAY['earning'::text, 'deduction'::text])));
ALTER TABLE public.payslips ADD CONSTRAINT payslips_check CHECK ((net = (gross - total_deductions)));
ALTER TABLE public.payslips ADD CONSTRAINT payslips_gross_check CHECK ((gross >= (0)::numeric));
ALTER TABLE public.payslips ADD CONSTRAINT payslips_net_check CHECK ((net >= (0)::numeric));
ALTER TABLE public.payslips ADD CONSTRAINT payslips_total_deductions_check CHECK ((total_deductions >= (0)::numeric));
ALTER TABLE public.periods ADD CONSTRAINT periods_check CHECK ((end_time > start_time));
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_unit_cost_check CHECK ((unit_cost >= (0)::numeric));
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ordered'::text, 'received'::text, 'cancelled'::text])));
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_total_check CHECK ((total >= (0)::numeric));
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_check CHECK ((obtained_marks <= total_marks));
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_obtained_marks_check CHECK ((obtained_marks >= (0)::numeric));
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_percentage_check CHECK (((percentage >= (0)::numeric) AND (percentage <= (100)::numeric)));
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_rank_check CHECK ((rank > 0));
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_total_marks_check CHECK ((total_marks >= (0)::numeric));
ALTER TABLE public.rooms ADD CONSTRAINT rooms_capacity_check CHECK ((capacity > 0));
ALTER TABLE public.rooms ADD CONSTRAINT rooms_room_type_check CHECK ((room_type = ANY (ARRAY['classroom'::text, 'lab'::text, 'library'::text, 'hall'::text, 'other'::text])));
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_monthly_fee_check CHECK ((monthly_fee >= (0)::numeric));
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_stop_order_check CHECK ((stop_order > 0));
ALTER TABLE public.salary_components ADD CONSTRAINT salary_components_calc_type_check CHECK ((calc_type = ANY (ARRAY['fixed'::text, 'percent'::text])));
ALTER TABLE public.salary_components ADD CONSTRAINT salary_components_type_check CHECK ((type = ANY (ARRAY['earning'::text, 'deduction'::text])));
ALTER TABLE public.sections ADD CONSTRAINT sections_capacity_check CHECK ((capacity > 0));
ALTER TABLE public.staff ADD CONSTRAINT staff_check CHECK ((join_date > dob));
ALTER TABLE public.staff ADD CONSTRAINT staff_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])));
ALTER TABLE public.staff ADD CONSTRAINT staff_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resigned'::text, 'terminated'::text])));
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_check CHECK ((recovered <= amount));
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_monthly_deduction_check CHECK ((monthly_deduction > (0)::numeric));
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_recovered_check CHECK ((recovered >= (0)::numeric));
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cleared'::text, 'cancelled'::text])));
ALTER TABLE public.staff_attendance ADD CONSTRAINT staff_attendance_check CHECK (((check_out IS NULL) OR (check_in IS NULL) OR (check_out > check_in)));
ALTER TABLE public.staff_attendance ADD CONSTRAINT staff_attendance_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text, 'leave'::text, 'half_day'::text])));
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_basic_salary_check CHECK ((basic_salary >= (0)::numeric));
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_check CHECK (((end_date IS NULL) OR (end_date > start_date)));
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_contract_type_check CHECK ((contract_type = ANY (ARRAY['permanent'::text, 'contract'::text, 'probation'::text, 'part_time'::text])));
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'expired'::text, 'terminated'::text])));
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_allotted_check CHECK ((allotted >= (0)::numeric));
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_check CHECK ((used <= allotted));
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_used_check CHECK ((used >= (0)::numeric));
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_basic_salary_check CHECK ((basic_salary >= (0)::numeric));
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_check CHECK (((effective_to IS NULL) OR (effective_to > effective_from)));
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_check CHECK (((type = 'adjustment'::text) OR (quantity > (0)::numeric)));
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_quantity_check CHECK ((quantity <> (0)::numeric));
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_type_check CHECK ((type = ANY (ARRAY['in'::text, 'out'::text, 'adjustment'::text])));
ALTER TABLE public.student_attendance ADD CONSTRAINT student_attendance_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text, 'late'::text, 'leave'::text])));
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_check CHECK (((valid_to IS NULL) OR (valid_to >= valid_from)));
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_roll_no_check CHECK ((roll_no > 0));
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'promoted'::text, 'detained'::text, 'withdrawn'::text, 'transferred'::text])));
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_relation_check CHECK ((relation = ANY (ARRAY['father'::text, 'mother'::text, 'guardian'::text, 'brother'::text, 'sister'::text, 'uncle'::text, 'aunt'::text, 'other'::text])));
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_action_check CHECK ((action = ANY (ARRAY['promoted'::text, 'detained'::text, 'graduated'::text])));
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_check CHECK ((((action = 'graduated'::text) AND (to_enrollment_id IS NULL)) OR (action <> 'graduated'::text)));
ALTER TABLE public.student_transport ADD CONSTRAINT student_transport_check CHECK (((end_date IS NULL) OR (end_date >= start_date)));
ALTER TABLE public.student_transport ADD CONSTRAINT student_transport_monthly_fee_check CHECK ((monthly_fee >= (0)::numeric));
ALTER TABLE public.students ADD CONSTRAINT students_blood_group_check CHECK ((blood_group = ANY (ARRAY['A+'::text, 'A-'::text, 'B+'::text, 'B-'::text, 'AB+'::text, 'AB-'::text, 'O+'::text, 'O-'::text])));
ALTER TABLE public.students ADD CONSTRAINT students_check CHECK ((dob < admission_date));
ALTER TABLE public.students ADD CONSTRAINT students_gender_check CHECK ((gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text])));
ALTER TABLE public.students ADD CONSTRAINT students_status_check CHECK ((status = ANY (ARRAY['active'::text, 'withdrawn'::text, 'transferred'::text, 'graduated'::text])));
ALTER TABLE public.subjects ADD CONSTRAINT subjects_type_check CHECK ((type = ANY (ARRAY['core'::text, 'elective'::text, 'co_curricular'::text])));
ALTER TABLE public.terms ADD CONSTRAINT terms_check CHECK ((end_date > start_date));
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_day_of_week_check CHECK (((day_of_week >= 1) AND (day_of_week <= 7)));
ALTER TABLE public.users ADD CONSTRAINT users_check CHECK ((((user_type = ANY (ARRAY['admin'::text, 'staff'::text])) AND (guardian_id IS NULL) AND (student_id IS NULL)) OR ((user_type = 'guardian'::text) AND (guardian_id IS NOT NULL) AND (staff_id IS NULL) AND (student_id IS NULL)) OR ((user_type = 'student'::text) AND (student_id IS NOT NULL) AND (staff_id IS NULL) AND (guardian_id IS NULL))));
ALTER TABLE public.users ADD CONSTRAINT users_failed_attempts_check CHECK ((failed_attempts >= 0));
ALTER TABLE public.users ADD CONSTRAINT users_user_type_check CHECK ((user_type = ANY (ARRAY['admin'::text, 'staff'::text, 'guardian'::text, 'student'::text])));
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_capacity_check CHECK ((capacity > 0));
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_check CHECK ((((debit = (0)::numeric) AND (credit > (0)::numeric)) OR ((credit = (0)::numeric) AND (debit > (0)::numeric))));
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_credit_check CHECK ((credit >= (0)::numeric));
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_debit_check CHECK ((debit >= (0)::numeric));
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text])));
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_type_check CHECK ((type = ANY (ARRAY['receipt'::text, 'payment'::text, 'journal'::text])));
ALTER TABLE public.account_heads ADD CONSTRAINT account_heads_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_applied_class_id_fkey FOREIGN KEY (applied_class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.admission_applications ADD CONSTRAINT admission_applications_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_account_head_id_fkey FOREIGN KEY (account_head_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_book_id_fkey FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT;
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.book_issues ADD CONSTRAINT book_issues_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.books ADD CONSTRAINT books_category_id_fkey FOREIGN KEY (category_id) REFERENCES book_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.budgets ADD CONSTRAINT budgets_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.budgets ADD CONSTRAINT budgets_account_head_id_fkey FOREIGN KEY (account_head_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.class_subjects ADD CONSTRAINT class_subjects_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.class_subjects ADD CONSTRAINT class_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
ALTER TABLE public.designations ADD CONSTRAINT designations_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT;
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE RESTRICT;
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT;
ALTER TABLE public.exam_schedules ADD CONSTRAINT exam_schedules_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
ALTER TABLE public.exams ADD CONSTRAINT exams_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.exams ADD CONSTRAINT exams_exam_type_id_fkey FOREIGN KEY (exam_type_id) REFERENCES exam_types(id) ON DELETE RESTRICT;
ALTER TABLE public.exams ADD CONSTRAINT exams_term_id_fkey FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_account_head_id_fkey FOREIGN KEY (account_head_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_categories ADD CONSTRAINT fee_categories_income_head_id_fkey FOREIGN KEY (income_head_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_fee_category_id_fkey FOREIGN KEY (fee_category_id) REFERENCES fee_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_invoice_items ADD CONSTRAINT fee_invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES fee_invoices(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_invoices ADD CONSTRAINT fee_invoices_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.fee_structures ADD CONSTRAINT fee_structures_fee_category_id_fkey FOREIGN KEY (fee_category_id) REFERENCES fee_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.fine_rules ADD CONSTRAINT fine_rules_fee_category_id_fkey FOREIGN KEY (fee_category_id) REFERENCES fee_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.grading_scale_ranges ADD CONSTRAINT grading_scale_ranges_grading_scale_id_fkey FOREIGN KEY (grading_scale_id) REFERENCES grading_scales(id) ON DELETE RESTRICT;
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_fee_invoice_id_fkey FOREIGN KEY (fee_invoice_id) REFERENCES fee_invoices(id) ON DELETE RESTRICT;
ALTER TABLE public.items ADD CONSTRAINT items_category_id_fkey FOREIGN KEY (category_id) REFERENCES item_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE RESTRICT;
ALTER TABLE public.leave_requests ADD CONSTRAINT leave_requests_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_book_issue_id_fkey FOREIGN KEY (book_issue_id) REFERENCES book_issues(id) ON DELETE RESTRICT;
ALTER TABLE public.library_fines ADD CONSTRAINT library_fines_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT;
ALTER TABLE public.marks ADD CONSTRAINT marks_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.marks ADD CONSTRAINT marks_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.marks ADD CONSTRAINT marks_exam_schedule_id_fkey FOREIGN KEY (exam_schedule_id) REFERENCES exam_schedules(id) ON DELETE RESTRICT;
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES guardians(id) ON DELETE RESTRICT;
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE RESTRICT;
ALTER TABLE public.notification_logs ADD CONSTRAINT notification_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES fee_invoices(id) ON DELETE RESTRICT;
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES guardians(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_received_by_fkey FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_reversed_by_fkey FOREIGN KEY (reversed_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.payroll_runs ADD CONSTRAINT payroll_runs_run_by_fkey FOREIGN KEY (run_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.payslip_items ADD CONSTRAINT payslip_items_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES payslips(id) ON DELETE RESTRICT;
ALTER TABLE public.payslip_items ADD CONSTRAINT payslip_items_salary_component_id_fkey FOREIGN KEY (salary_component_id) REFERENCES salary_components(id) ON DELETE RESTRICT;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE RESTRICT;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT;
ALTER TABLE public.purchase_order_items ADD CONSTRAINT purchase_order_items_po_id_fkey FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT;
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.report_cards ADD CONSTRAINT report_cards_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE RESTRICT;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE RESTRICT;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
ALTER TABLE public.route_stops ADD CONSTRAINT route_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE RESTRICT;
ALTER TABLE public.routes ADD CONSTRAINT routes_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE RESTRICT;
ALTER TABLE public.sections ADD CONSTRAINT sections_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.sections ADD CONSTRAINT sections_class_teacher_id_fkey FOREIGN KEY (class_teacher_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff ADD CONSTRAINT staff_department_id_fkey FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT;
ALTER TABLE public.staff ADD CONSTRAINT staff_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES designations(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_advances ADD CONSTRAINT staff_advances_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_attendance ADD CONSTRAINT staff_attendance_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_contracts ADD CONSTRAINT staff_contracts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_documents ADD CONSTRAINT staff_documents_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_leave_type_id_fkey FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_leave_balances ADD CONSTRAINT staff_leave_balances_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_salary_structure_id_fkey FOREIGN KEY (salary_structure_id) REFERENCES salary_structures(id) ON DELETE RESTRICT;
ALTER TABLE public.staff_salaries ADD CONSTRAINT staff_salaries_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_moved_by_fkey FOREIGN KEY (moved_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_attendance ADD CONSTRAINT student_attendance_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_attendance ADD CONSTRAINT student_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discipline_records ADD CONSTRAINT student_discipline_records_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discipline_records ADD CONSTRAINT student_discipline_records_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_discount_id_fkey FOREIGN KEY (discount_id) REFERENCES discounts(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_discounts ADD CONSTRAINT student_discounts_fee_category_id_fkey FOREIGN KEY (fee_category_id) REFERENCES fee_categories(id) ON DELETE RESTRICT;
ALTER TABLE public.student_documents ADD CONSTRAINT student_documents_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.student_documents ADD CONSTRAINT student_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE RESTRICT;
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_section_id_class_id_fkey FOREIGN KEY (section_id, class_id) REFERENCES sections(id, class_id) ON DELETE RESTRICT;
ALTER TABLE public.student_enrollments ADD CONSTRAINT student_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES guardians(id) ON DELETE RESTRICT;
ALTER TABLE public.student_guardians ADD CONSTRAINT student_guardians_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.student_health_records ADD CONSTRAINT student_health_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.student_leaving_records ADD CONSTRAINT student_leaving_records_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_leaving_records ADD CONSTRAINT student_leaving_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_from_enrollment_id_fkey FOREIGN KEY (from_enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_promotions ADD CONSTRAINT student_promotions_to_enrollment_id_fkey FOREIGN KEY (to_enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_transport ADD CONSTRAINT student_transport_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES student_enrollments(id) ON DELETE RESTRICT;
ALTER TABLE public.student_transport ADD CONSTRAINT student_transport_route_stop_id_fkey FOREIGN KEY (route_stop_id) REFERENCES route_stops(id) ON DELETE RESTRICT;
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_section_id_fkey FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE RESTRICT;
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.subject_teachers ADD CONSTRAINT subject_teachers_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_substitute_staff_id_fkey FOREIGN KEY (substitute_staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.substitutions ADD CONSTRAINT substitutions_timetable_entry_id_fkey FOREIGN KEY (timetable_entry_id) REFERENCES timetable_entries(id) ON DELETE RESTRICT;
ALTER TABLE public.terms ADD CONSTRAINT terms_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_section_id_fkey FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.timetable_entries ADD CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE public.users ADD CONSTRAINT users_guardian_id_fkey FOREIGN KEY (guardian_id) REFERENCES guardians(id) ON DELETE RESTRICT;
ALTER TABLE public.users ADD CONSTRAINT users_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE RESTRICT;
ALTER TABLE public.users ADD CONSTRAINT users_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE RESTRICT;
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_account_head_id_fkey FOREIGN KEY (account_head_id) REFERENCES account_heads(id) ON DELETE RESTRICT;
ALTER TABLE public.voucher_entries ADD CONSTRAINT voucher_entries_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE RESTRICT;
ALTER TABLE public.vouchers ADD CONSTRAINT vouchers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;

-- Indexes
CREATE UNIQUE INDEX uq_one_current_year ON public.academic_years USING btree (is_current) WHERE is_current;
CREATE INDEX ix_audit_table_rec ON public.audit_logs USING btree (table_name, record_id);
CREATE INDEX ix_audit_user_time ON public.audit_logs USING btree (user_id, created_at);
CREATE INDEX ix_book_issues_book ON public.book_issues USING btree (book_id, status);
CREATE INDEX ix_invoice_items_inv ON public.fee_invoice_items USING btree (invoice_id);
CREATE INDEX ix_invoice_status_due ON public.fee_invoices USING btree (status, due_date);
CREATE UNIQUE INDEX uq_one_default_scale ON public.grading_scales USING btree (is_default) WHERE is_default;
CREATE INDEX ix_guardians_phone ON public.guardians USING btree (phone);
CREATE INDEX ix_marks_enrollment ON public.marks USING btree (enrollment_id);
CREATE INDEX ix_notif_logs_notif ON public.notification_logs USING btree (notification_id);
CREATE INDEX ix_pay_alloc_invoice ON public.payment_allocations USING btree (invoice_id);
CREATE INDEX ix_payments_paid_at ON public.payments USING btree (paid_at);
CREATE INDEX ix_report_enrollment ON public.report_cards USING btree (enrollment_id);
CREATE INDEX ix_stock_item ON public.stock_movements USING btree (item_id, moved_at);
CREATE INDEX ix_att_date ON public.student_attendance USING btree (att_date);
CREATE INDEX ix_enroll_class_section ON public.student_enrollments USING btree (academic_year_id, class_id, section_id);
CREATE INDEX ix_sg_guardian ON public.student_guardians USING btree (guardian_id);
CREATE UNIQUE INDEX uq_one_primary_guardian ON public.student_guardians USING btree (student_id) WHERE is_primary;
CREATE UNIQUE INDEX uq_one_active_transport ON public.student_transport USING btree (enrollment_id) WHERE (end_date IS NULL);
CREATE INDEX ix_students_name ON public.students USING btree (lower(first_name), lower(last_name));
CREATE INDEX ix_students_status ON public.students USING btree (status) WHERE (deleted_at IS NULL);
CREATE INDEX ix_ss_staff ON public.subject_teachers USING btree (staff_id);
CREATE INDEX ix_voucher_entries_h ON public.voucher_entries USING btree (account_head_id);
CREATE INDEX ix_voucher_entries_v ON public.voucher_entries USING btree (voucher_id);

-- Triggers
CREATE TRIGGER trg_academic_years_updated BEFORE UPDATE ON public.academic_years FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_account_heads_updated BEFORE UPDATE ON public.account_heads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_admission_applications_updated BEFORE UPDATE ON public.admission_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_immutable BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_bank_accounts_updated BEFORE UPDATE ON public.bank_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_book_categories_updated BEFORE UPDATE ON public.book_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_book_issues_updated BEFORE UPDATE ON public.book_issues FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_books_updated BEFORE UPDATE ON public.books FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_budgets_updated BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_class_subjects_updated BEFORE UPDATE ON public.class_subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_classes_updated BEFORE UPDATE ON public.classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_departments_updated BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_designations_updated BEFORE UPDATE ON public.designations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_discounts AFTER INSERT OR DELETE OR UPDATE ON public.discounts FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_discounts_updated BEFORE UPDATE ON public.discounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_drivers_updated BEFORE UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exam_schedules_updated BEFORE UPDATE ON public.exam_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exam_types_updated BEFORE UPDATE ON public.exam_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_exams_updated BEFORE UPDATE ON public.exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fee_categories_updated BEFORE UPDATE ON public.fee_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fee_invoice_items_updated BEFORE UPDATE ON public.fee_invoice_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_fee_invoices AFTER INSERT OR DELETE OR UPDATE ON public.fee_invoices FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_fee_invoices_updated BEFORE UPDATE ON public.fee_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fee_structures_updated BEFORE UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_fine_rules_updated BEFORE UPDATE ON public.fine_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_grading_scale_ranges_updated BEFORE UPDATE ON public.grading_scale_ranges FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_grading_scales_updated BEFORE UPDATE ON public.grading_scales FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_guardians AFTER INSERT OR DELETE OR UPDATE ON public.guardians FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_guardians_updated BEFORE UPDATE ON public.guardians FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_installment_plans_updated BEFORE UPDATE ON public.installment_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_item_categories_updated BEFORE UPDATE ON public.item_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_items_updated BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leave_requests_updated BEFORE UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leave_types_updated BEFORE UPDATE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_library_fines_updated BEFORE UPDATE ON public.library_fines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_marks AFTER INSERT OR DELETE OR UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_guard_marks BEFORE INSERT OR UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION guard_marks();
CREATE TRIGGER trg_marks_updated BEFORE UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_notifications_updated BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_alloc_immutable BEFORE DELETE OR UPDATE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_alloc_recompute AFTER INSERT ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION trg_alloc_after_insert();
CREATE CONSTRAINT TRIGGER trg_alloc_total AFTER INSERT ON public.payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_allocation_total();
CREATE TRIGGER trg_audit_payments AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_guard_payments BEFORE DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION guard_payments();
CREATE TRIGGER trg_payment_reversal AFTER UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION trg_payment_reversed();
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payroll_runs_updated BEFORE UPDATE ON public.payroll_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_payslips AFTER INSERT OR DELETE OR UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_guard_payslips BEFORE DELETE OR UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION guard_payslips();
CREATE TRIGGER trg_payslips_updated BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_periods_updated BEFORE UPDATE ON public.periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_permissions_updated BEFORE UPDATE ON public.permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_order_items_updated BEFORE UPDATE ON public.purchase_order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_orders_updated BEFORE UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_report_cards_updated BEFORE UPDATE ON public.report_cards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_role_permissions AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_roles AFTER INSERT OR DELETE OR UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_rooms_updated BEFORE UPDATE ON public.rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_route_stops_updated BEFORE UPDATE ON public.route_stops FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_routes_updated BEFORE UPDATE ON public.routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_salary_components_updated BEFORE UPDATE ON public.salary_components FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_salary_structures_updated BEFORE UPDATE ON public.salary_structures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sections_updated BEFORE UPDATE ON public.sections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_staff AFTER INSERT OR DELETE OR UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_staff_updated BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_advances_updated BEFORE UPDATE ON public.staff_advances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_attendance_updated BEFORE UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_contracts_updated BEFORE UPDATE ON public.staff_contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_documents_updated BEFORE UPDATE ON public.staff_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_staff_leave_balances_updated BEFORE UPDATE ON public.staff_leave_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_staff_salaries AFTER INSERT OR DELETE OR UPDATE ON public.staff_salaries FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_staff_salaries_updated BEFORE UPDATE ON public.staff_salaries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_stock_immutable BEFORE DELETE OR UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_student_attendance_updated BEFORE UPDATE ON public.student_attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_discipline_records_updated BEFORE UPDATE ON public.student_discipline_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_student_discounts AFTER INSERT OR DELETE OR UPDATE ON public.student_discounts FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_student_discounts_updated BEFORE UPDATE ON public.student_discounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_documents_updated BEFORE UPDATE ON public.student_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_student_enrollments AFTER INSERT OR DELETE OR UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_enroll_closed_year BEFORE INSERT OR DELETE OR UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION guard_closed_year();
CREATE TRIGGER trg_student_enrollments_updated BEFORE UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_guardians_updated BEFORE UPDATE ON public.student_guardians FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_health_records_updated BEFORE UPDATE ON public.student_health_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_leaving_records_updated BEFORE UPDATE ON public.student_leaving_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_promotions_updated BEFORE UPDATE ON public.student_promotions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_student_transport_updated BEFORE UPDATE ON public.student_transport FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_transport_capacity BEFORE INSERT OR UPDATE ON public.student_transport FOR EACH ROW EXECUTE FUNCTION check_vehicle_capacity();
CREATE TRIGGER trg_audit_students AFTER INSERT OR DELETE OR UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_students_updated BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subject_teachers_updated BEFORE UPDATE ON public.subject_teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subjects_updated BEFORE UPDATE ON public.subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_substitutions_updated BEFORE UPDATE ON public.substitutions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_terms_updated BEFORE UPDATE ON public.terms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_timetable_entries_updated BEFORE UPDATE ON public.timetable_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_user_roles AFTER INSERT OR DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_users AFTER INSERT OR DELETE OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_vehicles_updated BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_guard_v_entries BEFORE DELETE OR UPDATE ON public.voucher_entries FOR EACH ROW EXECUTE FUNCTION guard_posted_voucher();
CREATE TRIGGER trg_guard_voucher BEFORE DELETE OR UPDATE ON public.vouchers FOR EACH ROW EXECUTE FUNCTION guard_posted_voucher();
CREATE CONSTRAINT TRIGGER trg_voucher_balance AFTER INSERT OR UPDATE ON public.vouchers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_voucher_balance();
CREATE TRIGGER trg_vouchers_updated BEFORE UPDATE ON public.vouchers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row level security is deliberately NOT enabled here. It is enforced in
-- the service and policy layer instead; see docs/00-README-INDEX.md.

-- Down Migration
--
-- There is deliberately no down migration for the baseline. Reversing it
-- means dropping every table in the school database, which is not an
-- operation that should be one mistyped command away. Rebuild from this
-- file into a fresh database instead.
SELECT 'the baseline migration cannot be reversed' AS refused;
