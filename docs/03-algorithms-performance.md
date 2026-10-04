# File 3 of 6: Part 9 (Data Structures and Algorithms for Performance)

Apply the right data structure or algorithm where it actually helps. Do not over-engineer. Measure with realistic volumes (for example 5,000 students, 60,000 attendance rows per month, 200,000 invoices, 1,000,000 audit rows) and add indexes or changes only where evidence shows a need.

# 9.1 Searching
- Student and guardian search by name, admission number, phone and national ID uses database indexes designed for it. Exact lookups (admission number, national ID, receipt number, invoice number, employee number, accession number) use unique B-tree indexes and must be O(log n).
- Name and partial text search use trigram indexes (pg_trgm, approved) and prefix matching, or full-text search where relevant. Case-insensitive matching must use the same expression as the index so the index is actually used.
- Typeahead or autocomplete (student pickers in fee collection and library): prefix search with a small result limit, debounce-friendly responses, short cache times, minimal fields only.
- Unified search endpoint: detect the query type (admission number, phone number, national ID, or name) and route to the cheapest matching strategy first.
- Never use leading-wildcard scans on big tables without a supporting trigram index.

# 9.2 Pagination and listing
- Keyset pagination as described in Part 5. Composite indexes must match the filter and sort order of the most common list queries (for example enrollment and date for attendance, status and due date for invoices, paid-at for payments).

# 9.3 Inserting and bulk operations
- Batched multi-row inserts and set-based SQL for bulk work, never one query per row in a loop. Examples: marking attendance for a whole section (one bulk upsert), entering marks for a whole class, generating monthly invoices for thousands of enrollments, generating payslips for all staff, importing students from a spreadsheet, promoting a whole class at year end.
- Upsert semantics with the table's unique keys so retries are safe.
- Chunk very large batches (500 to 1000 rows per statement) and process them in jobs with progress tracking.
- Avoid N+1: load related data with joins or batched lookups (load by list of ids and index results in a hash map by id for O(1) access). Provide a reusable loader or batching helper.
- Dashboards and repeated aggregates: prefer database aggregation (group by, filtered aggregates, window functions) over computing in application code. Use materialized views or summary tables refreshed by jobs for heavy analytics (fee collection summaries, attendance percentages, enrollment counts), with a defined refresh schedule and a last-refreshed time shown in responses.

# 9.4 In-memory structures and algorithms where they fit
- Hash maps and sets for O(1) lookups: permission sets per user, class and subject maps, duplicate detection during imports, roll number collision detection, membership checks.
- LRU cache with TTL for reference data and per-user permissions.
- Timetable clash detection and generation: model each teacher, section and room as a set of occupied (day, period) slots. Use hash sets for constant-time clash checks. For automatic timetable suggestions use a constraint-based approach: greedy assignment with backtracking ordered by the most constrained subject or teacher first. Database unique constraints remain the final guard.
- Interval logic for overlapping date ranges (contracts, salary periods, discount validity, transport periods): sorted-interval or sweep-line checks before hitting the database, which also enforces it.
- Exam ranking: sort followed by a single pass that handles ties consistently (same total gets the same rank, next rank skips accordingly). Use a heap only when only the top N is needed. Do the ranking set-based with window functions where possible.
- Grade lookup: keep grading scale ranges sorted in memory and use binary search to find the grade for a percentage.
- Fee calculation: precompute the fee structure per class and academic year in a map; apply discounts and fines through a rule pipeline (strategy objects in a defined order), then round once at the end with a defined rounding rule. Apply payments to invoices using a defined allocation strategy (oldest due date first, using a priority queue or sorted list) when a parent pays a lump sum across siblings' invoices, with an option for manual allocation.
- Fine computation: compute days late with date arithmetic, apply grace days, cap according to the rule. Run nightly in a job as a set-based update, not per-invoice loops.
- Library: availability is copies total minus currently issued copies, checked inside a transaction with a row lock to prevent over-issuing.
- Inventory: current stock is derived from stock movements. For fast reads, maintain a summarized stock level per item, refreshed on each movement in the same transaction, and provide a reconciliation job that compares the summary to the sum of movements and reports drift. (This summary needs a schema addition: propose it and wait.)
- Trees: the chart of accounts is a tree. Use recursive queries (recursive CTEs) to roll up balances, and detect cycles when a parent is set.
- Transport: ordered stops per route, with capacity checks.
- Sorting and merging: stable sorts, and for exports stream rows instead of loading everything in memory.
- Text processing: normalize phone numbers to one canonical format before storing and comparing. Normalize names for search (trim, collapse spaces, case-fold).
- Deduplication: detect probable duplicate students or guardians at admission by matching national ID, phone, and normalized name plus date of birth, and warn before creating a duplicate.

# 9.5 Concurrency and correctness
- Anything that must not double-spend or double-issue uses a transaction with row-level locks on the specific rows (lock invoice rows before recording a payment, lock the book row before issuing, lock the stock item before an outgoing movement). Lock rows in a consistent order (ascending id) to avoid deadlocks.
- Use database sequences for all human-readable numbers (provided by the schema). Never generate numbers in application code.
- Optimistic concurrency for records that several people may edit at once: include an updated-at version check on update and return a conflict error if the record changed since it was read.

# 9.6 Streaming and exports
- Exports (CSV, Excel, PDF) run as jobs for large data, stream to file, and are delivered by an authenticated download link with expiry. Small exports may run inline. Rate-limit and permission-protect every export, and log who exported what.
