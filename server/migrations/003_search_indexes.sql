-- 003_search_indexes.sql
--
-- Trigram and prefix indexes for people and book search (Part 9.1), approved in
-- docs/00-README-INDEX.md decision 5.
--
-- What was already covered, and therefore is NOT duplicated here: exact lookups
-- on admission_no, national_id, employee_no and accession_no are already unique
-- B-tree constraints in the baseline, so they are O(log n) as Part 9.1 requires.
--
-- What was missing is everything a human actually types at a counter: a partial
-- name, or a phone number. Without a trigram index, `name ILIKE '%ali%'` is a
-- sequential scan of every student, which is the leading-wildcard case Part 9.1
-- forbids on a large table.
--
-- Two index kinds per name column, because they answer different questions:
--
--   * GIN + gin_trgm_ops serves "contains" and fuzzy/similarity search. This is
--     the one that makes `%ali%` cheap.
--   * B-tree + text_pattern_ops serves "starts with" for typeahead. A prefix
--     search can use a B-tree range scan, which is cheaper and better-ordered
--     than trigram matching, and typeahead is the highest-frequency search in
--     the system (the student picker in fee collection and library issue).
--
-- CRITICAL: an expression index is only used when a query repeats the
-- expression *exactly*. `students` has no full_name column — it has first_name
-- and a NULLABLE last_name — so the searchable name is a concatenation, and
-- `lower(first_name || ' ' || coalesce(last_name, ''))` must be reproduced
-- character for character. It is defined once in
-- src/core/search/search-expressions.ts and referenced from there, never
-- retyped. Change it in one place and the index stops being used, silently, and
-- the only symptom is that search gets slow as the school grows.
--
-- Every index is partial on `deleted_at IS NULL`, because every search excludes
-- soft-deleted rows. That keeps the indexes smaller and skips the dead rows.

-- Up Migration

CREATE EXTENSION IF NOT EXISTS pg_trgm;

/* ---------------------------------------------------------------- *
 * Students
 * ---------------------------------------------------------------- */

CREATE INDEX students_name_trgm_idx ON students
  USING gin ((lower(first_name || ' ' || coalesce(last_name, ''))) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX students_name_prefix_idx ON students
  ((lower(first_name || ' ' || coalesce(last_name, ''))) text_pattern_ops)
  WHERE deleted_at IS NULL;

-- Phones are stored in one canonical normalized form (Part 9.4), so an exact
-- match is the right lookup and a B-tree is enough.
CREATE INDEX students_phone_idx ON students (phone)
  WHERE deleted_at IS NULL AND phone IS NOT NULL;

-- "All the admissions from 2026": a prefix range scan on an otherwise
-- equality-only unique index.
CREATE INDEX students_admission_no_prefix_idx ON students (admission_no text_pattern_ops)
  WHERE deleted_at IS NULL;

/* ---------------------------------------------------------------- *
 * Guardians
 * ---------------------------------------------------------------- */

CREATE INDEX guardians_name_trgm_idx ON guardians
  USING gin ((lower(full_name)) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX guardians_name_prefix_idx ON guardians
  ((lower(full_name)) text_pattern_ops)
  WHERE deleted_at IS NULL;

-- No guardian phone index is created here. The schema already ships
-- `ix_guardians_phone` on the same column, which covers the "a parent phones in
-- and reception has only the number" lookup and the sibling-admission search.
-- 003 originally added a partial duplicate; 004 removes it.

/* ---------------------------------------------------------------- *
 * Staff
 * ---------------------------------------------------------------- */

CREATE INDEX staff_name_trgm_idx ON staff
  USING gin ((lower(full_name)) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX staff_name_prefix_idx ON staff
  ((lower(full_name)) text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX staff_phone_idx ON staff (phone)
  WHERE deleted_at IS NULL;

/* ---------------------------------------------------------------- *
 * Books
 * ---------------------------------------------------------------- */

CREATE INDEX books_title_trgm_idx ON books
  USING gin ((lower(title)) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX books_title_prefix_idx ON books
  ((lower(title)) text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX books_author_trgm_idx ON books
  USING gin ((lower(coalesce(author, ''))) gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- ISBN is not unique in this schema (several copies, and reissued ISBNs), so it
-- needs its own index for the scan-a-barcode lookup.
CREATE INDEX books_isbn_idx ON books (isbn)
  WHERE deleted_at IS NULL AND isbn IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS students_name_trgm_idx;
DROP INDEX IF EXISTS students_name_prefix_idx;
DROP INDEX IF EXISTS students_phone_idx;
DROP INDEX IF EXISTS students_admission_no_prefix_idx;
DROP INDEX IF EXISTS guardians_name_trgm_idx;
DROP INDEX IF EXISTS guardians_name_prefix_idx;
DROP INDEX IF EXISTS staff_name_trgm_idx;
DROP INDEX IF EXISTS staff_name_prefix_idx;
DROP INDEX IF EXISTS staff_phone_idx;
DROP INDEX IF EXISTS books_title_trgm_idx;
DROP INDEX IF EXISTS books_title_prefix_idx;
DROP INDEX IF EXISTS books_author_trgm_idx;
DROP INDEX IF EXISTS books_isbn_idx;

-- pg_trgm is left installed: dropping an extension other objects may come to
-- depend on is not a safe automatic reversal.
