-- 008_public_refs.sql
--
-- Proposal 4 in docs/schema-proposals.md, approved. Part 12.
--
-- Part 12 asks for a public, heavily rate-limited endpoint that verifies a
-- receipt or a certificate by number.
--
-- It must not be built on `payments.receipt_no` or the certificate number.
-- Those come from database sequences, so they are consecutive and guessable:
-- anyone who has seen one receipt could walk the range and enumerate every
-- payment the school has ever taken, including which families paid and when.
-- That is a worse leak than not having the feature.
--
-- So each gets a random UUID for external use. The sequence number stays the
-- human-facing reference printed on the document and used internally; the UUID
-- is what the verification URL carries. Knowing one tells you nothing about any
-- other.
--
-- gen_random_uuid() comes from pgcrypto, which is already installed.
--
-- NOT NULL with a default is safe here: existing rows are backfilled by the
-- default as the column is added, and both tables are currently empty anyway.

-- Up Migration

ALTER TABLE payments
  ADD COLUMN public_ref uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE payments
  ADD CONSTRAINT payments_public_ref_key UNIQUE (public_ref);

ALTER TABLE student_leaving_records
  ADD COLUMN public_ref uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE student_leaving_records
  ADD CONSTRAINT student_leaving_records_public_ref_key UNIQUE (public_ref);

COMMENT ON COLUMN payments.public_ref IS
  'Unguessable external identifier for receipt verification. receipt_no is sequential and must never be used in a public endpoint.';

COMMENT ON COLUMN student_leaving_records.public_ref IS
  'Unguessable external identifier for certificate verification.';

-- Down Migration

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_public_ref_key;
ALTER TABLE payments DROP COLUMN IF EXISTS public_ref;

ALTER TABLE student_leaving_records
  DROP CONSTRAINT IF EXISTS student_leaving_records_public_ref_key;
ALTER TABLE student_leaving_records DROP COLUMN IF EXISTS public_ref;
