-- 014_library_fine_reason_and_renewals.sql
--
-- Required by Section 5 (Library). Same pattern 012 already used for
-- `payslip_items.reason`: the brief asks for a field the baseline schema does
-- not carry, and the fix is one small, backward-compatible, nullable/defaulted
-- column rather than inventing a side table.
--
--   - `library_fines.waived_reason`: Module 12 says waiving a fine needs "a
--     reason" recorded. Nullable because it only applies to a waived fine.
--   - `book_issues.renewal_count`: Module 12 caps renewals at a configurable
--     limit (`library.max_renewals`), which requires counting renewals
--     somewhere. Unlike stock, there is no append-only ledger to derive it
--     from — a book issue is one row, renewed in place — so a counter on the
--     row itself is the natural, minimal fix. Defaults to 0 so every existing
--     row (there are none yet) reads as "never renewed".
--
-- No new tables.

-- Up Migration

ALTER TABLE library_fines ADD COLUMN waived_reason text;
ALTER TABLE book_issues ADD COLUMN renewal_count integer NOT NULL DEFAULT 0;
ALTER TABLE book_issues ADD CONSTRAINT book_issues_renewal_count_check CHECK (renewal_count >= 0);

-- Down Migration

ALTER TABLE book_issues DROP CONSTRAINT IF EXISTS book_issues_renewal_count_check;
ALTER TABLE book_issues DROP COLUMN IF EXISTS renewal_count;
ALTER TABLE library_fines DROP COLUMN IF EXISTS waived_reason;
