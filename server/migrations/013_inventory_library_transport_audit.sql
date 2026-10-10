-- 013_inventory_library_transport_audit.sql
--
-- Required by Section 5 (Inventory, Library, Transport). Same mechanism as
-- 011: these tables already exist in the baseline schema with a
-- `set_updated_at` BEFORE trigger but no `audit_row()` AFTER trigger, unlike
-- the tables that already carry one (`payments`, `payslips`, `marks`, ...).
--
-- Covers the workflow/money-bearing tables in these three modules:
--   - `purchase_orders`: the draft -> ordered -> received/cancelled workflow.
--   - `stock_movements`: append-only, never updated or deleted, so INSERT
--     only — the same reasoning as `voucher_entries`, which also audits
--     INSERT only.
--   - `book_issues`: the issued -> returned/lost workflow.
--   - `library_fines`: waiving and marking paid.
--   - `student_transport`: allocation and ending an allocation.
--
-- Reference/setup tables in these modules (`item_categories`, `items`,
-- `suppliers`, `book_categories`, `books`, `drivers`, `vehicles`, `routes`,
-- `route_stops`) are left unaudited, matching the existing pattern where
-- `fee_categories`, `classes` and `leave_types` are not audited either.
--
-- `purchase_order_items` is also left unaudited: it is a line item of
-- `purchase_orders`, the same way `fee_invoice_items` (audited nowhere) is a
-- line item of the audited `fee_invoices`.
--
-- No new columns, no new tables.

-- Up Migration

CREATE TRIGGER trg_audit_purchase_orders AFTER INSERT OR UPDATE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_stock_movements AFTER INSERT ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_book_issues AFTER INSERT OR UPDATE ON public.book_issues FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_library_fines AFTER INSERT OR UPDATE ON public.library_fines FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER trg_audit_student_transport AFTER INSERT OR UPDATE ON public.student_transport FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Down Migration

DROP TRIGGER IF EXISTS trg_audit_purchase_orders ON public.purchase_orders;
DROP TRIGGER IF EXISTS trg_audit_stock_movements ON public.stock_movements;
DROP TRIGGER IF EXISTS trg_audit_book_issues ON public.book_issues;
DROP TRIGGER IF EXISTS trg_audit_library_fines ON public.library_fines;
DROP TRIGGER IF EXISTS trg_audit_student_transport ON public.student_transport;
