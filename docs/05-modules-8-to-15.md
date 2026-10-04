# File 5 of 6: Part 10, Modules 8 to 15

Same rules as File 4: for every module implement repositories, services, controllers, routes, validation schemas, policies, permission codes, audit behavior, tests and OpenAPI docs. Every endpoint is authenticated, permission-protected, rate-limited and validated unless stated otherwise.

## MODULE 8: PAYROLL

Purpose: compute and pay salaries correctly and traceably.

- Salary components (earnings and deductions, fixed or percent), salary structures, and per-staff salary assignments with effective date ranges (no overlaps).
- Advances: issue, track recovery, and automatically include the monthly deduction in payroll until cleared.
- Payroll run workflow: create a run for a month and year (one per month). Generate payslips for all active staff as a background job using: the effective salary for that month; the attendance summary (unpaid absent days deducted at monthly salary divided by 30, stored as a setting); component calculations (percent components computed on the right base); advance recovery; and rounding once at the end. Each payslip stores item snapshots so later configuration changes never alter old payslips. The run stays in draft until reviewed. Approval is done by a DIFFERENT user than the creator (segregation of duties). After approval everything is frozen. Marking as paid records the payment date and emits an event for accounting to post vouchers.
- Payslip PDFs (single and bulk). Staff self-service access to their own payslips only.
- Reports: payroll summary by month, by department, and deduction summaries.

Rules:
- Money is decimal-safe. Net always equals gross minus deductions.
- Approved or paid runs cannot be modified. Corrections are made through an adjustment in the next run.
- Rate-limit, audit and permission-protect every payroll endpoint. Payroll is among the most sensitive data: restrict strictly.

## MODULE 9: TIMETABLE

Purpose: build and maintain conflict-free timetables.

- Periods (bell schedule) and rooms.
- Timetable entries per year, section, day and period with subject, teacher and room. Validate that the subject is mapped to the class, that the teacher is assigned to that subject and section, and check clashes for the section, the teacher and the room using in-memory slot sets before the write (database unique constraints remain the final guard). Return precise conflict messages (which teacher is busy in which section at that slot).
- Bulk save of a whole section timetable in one transaction.
- Auto-suggest generator: constraint-based greedy plus backtracking as in Part 9.4. Produces a proposal (not saved) that the user reviews and applies. Respect weekly periods per subject, teacher availability and room needs (labs).
- Views: by section, by teacher, by room. Teacher personal timetable for the teacher portal, student timetable for student and guardian portals.
- Substitutions: when a teacher is absent (integrated with staff leave and attendance), suggest free teachers for each affected period (no entry in that slot, no other substitution then, ranked by fewest substitutions that week for fairness), create the substitution, and notify the substitute.
- Printable timetables.

Rules:
- A teacher cannot be in two places at once, a section cannot have two subjects in one slot, a room cannot be double-booked.
- Timetable editing after the year is closed is blocked.

## MODULE 10: ACCOUNTING

Purpose: double-entry books that reflect fees, expenses, payroll and purchases.

- Chart of accounts (account heads as a tree), bank accounts.
- Vouchers and entries: manual journal, receipt and payment vouchers created as drafts, then posted. Posting validates that total debits equal total credits and freezes the voucher. Posted vouchers are never edited. Corrections use a reversing voucher.
- Automatic vouchers through events: a recorded fee payment creates a receipt voucher (debit cash or bank, credit the fee income head defined on the fee category); a reversed payment creates the opposite; payroll payment creates a payment voucher; approved expenses create payment vouchers; received purchase orders may create liability entries. Source type and source id link back to the origin. Event handlers must be idempotent (never post twice for the same source) and failures must be retried, never silently lost. Use the OUTBOX pattern: write the event in the same transaction as the business change, and a worker delivers it. (If an outbox table is not in the schema, propose it and wait.)
- Expenses: record with category (account head), method, attachment, approval workflow (creator differs from approver), and voucher linkage.
- Budgets per year and account head, with actual versus budget comparison.
- Reports: ledger per account head, trial balance, income and expense statement, cash book, bank book, balance summary for a date range. Set-based SQL and recursive roll-up for the account tree. Short-lived caches; materialized summaries only if measurements justify them.
- Bank reconciliation: not built now.

Rules:
- Debits equal credits, always. Amounts are positive with a single side per entry line (the schema enforces it).
- Financial year alignment with the academic year is configurable.
- Only accountant-level permissions may post; only a higher permission may reverse.

## MODULE 11: INVENTORY

Purpose: track stock of stationery, uniforms, books and assets consumed by the school. No selling module. Stock leaves through issues to departments or students, or adjustments.

- Item categories, items (SKU unique, unit, reorder level), suppliers.
- Purchase orders with items: draft, ordered, received, cancelled workflow. Receiving creates stock-in movements in one transaction and updates the PO status. Partial receiving is allowed.
- Stock movements: append-only ledger of in, out and adjustments. Outgoing movements check available quantity under a row lock so stock never goes negative. Adjustments require a reason and permission.
- Current stock derived from movements, with a maintained summary for fast reads and a reconciliation job (Part 9.4). The summary requires a schema addition: propose it and wait.
- Low-stock alerts: a job that lists items below the reorder level and notifies the store manager.
- Reports: stock on hand, stock valuation, movement history per item, supplier purchase history.

Rules:
- Movements are never edited or deleted. Corrections are new movements.
- Purchase orders in received or cancelled state are frozen.

## MODULE 12: LIBRARY

Purpose: manage books and lending.

- Book categories, books (accession number unique, ISBN, copies total, shelf location), search by title, author, ISBN and accession number (trigram and prefix strategies).
- Issue: for a student or staff member. Validate the borrowing limit per borrower type (configurable), availability (copies total minus currently issued, checked under a row lock), and that the borrower has no overdue books or unpaid library fines beyond a configurable policy. Due date comes from settings.
- Return: mark returned, compute the fine if late (per-day rate with grace days), create a library fine, support waiving with permission and reason.
- Renew: allowed a limited number of times. Reservations are NOT built.
- Lost books: mark lost, create a fine (replacement cost), reduce total copies through an explicit action.
- Library fines can be paid through the fee module's payment flow so the payment reference links to the fine. Status moves to paid only with a payment id (schema rule).
- Reports: currently issued, overdue list, most borrowed books, borrower history.
- Overdue reminders: a nightly job through the notification module.

## MODULE 13: TRANSPORT

Purpose: routes, vehicles, drivers, and student transport allocation with fee integration.

- Drivers, vehicles (capacity, insurance and fitness expiry), routes, ordered stops with pickup time and monthly fee.
- Student allocation: assign an enrollment to a route stop with a start date, checking vehicle capacity under a lock and preventing more than one active allocation per enrollment. End or change allocations (ending sets an end date, history is never deleted).
- Fee integration: the monthly transport fee is added as an invoice item during invoice generation for the periods the allocation is active. Default rule (stored in settings): full month if the allocation starts on or before the 15th, otherwise it starts next month.
- Compliance tracking: a job that flags expiring driver licenses, insurance and fitness certificates and notifies the administrator.
- Reports: students per route, vehicle occupancy, transport fee collection, route sheets for drivers.

## MODULE 14: NOTIFICATIONS AND PORTALS

Purpose: deliver information to guardians, students and staff, and give them safe, scoped access.

Notifications:
- Channels behind a common interface (SMS, WhatsApp, email, in-app), each a strategy selected by a factory. Implement in-app and email fully; SMS and WhatsApp are adapter stubs with clear configuration.
- Targets: all, a class, a section, a student's guardians, a specific guardian, or staff. Resolve recipients in the service, create one log row per recipient and channel, send through a queue with rate limiting, retries with backoff, and status tracking (queued, sent, failed, read).
- Templates with placeholders for common messages (absence alert, fee reminder, payment receipt, result published, leave decision, substitution, low stock, expiry alerts).
- Deduplicate and throttle (for example one fee reminder per guardian per configured interval).
- Users can list their in-app notifications, mark read, and mark all read.
- Notification preferences / opt-out: not built now (needs a new table; propose later).

Portals (no separate business logic, scoped views over existing modules):
- Guardian portal: my children, and per child: profile, attendance summary and calendar, fee invoices, payments and receipts, family dues view, report cards, timetable, transport details, library issues, notifications, and leave request submission. Online payment only when a gateway exists.
- Student portal: own profile, attendance, timetable, results, library issues, notifications.
- Teacher portal: my sections and subjects, take attendance, enter marks, my timetable, my substitutions, my leave requests and balances, my payslips, class lists.
- Every portal endpoint enforces the ownership rules of Part 7, in dedicated route groups with their own rate limits. Since RLS is disabled, the policy layer is the only barrier, so test it hardest here.

## MODULE 15: REPORTS AND ANALYTICS

Purpose: dashboards and exportable reports built on the other modules without new business tables.

- Dashboards per role: admin or principal (enrollment by class, attendance today, fee collected today and this month, outstanding dues, staff present today, upcoming exams, alerts), accountant (collection, dues aging, pending approvals), teacher (my classes, pending attendance and marks), guardian (children summary).
- Standard reports: student strength and demographics, admission trends, attendance (daily, monthly, defaulters), fee collection (daily, monthly, by class, by method), dues and aging, discount and fine summaries, exam analysis, staff attendance and leave, payroll summary, library usage, inventory stock, transport occupancy, and financial statements from accounting.
- Every report supports filters, a date range, sorting by allow-listed columns, and export to CSV, Excel and PDF. Large exports run as jobs.
- Implementation: database views and materialized views for heavy aggregates with scheduled refresh, set-based SQL, keyset pagination for detail tables, short-lived caches for dashboards. Report queries use the read-only reporting role (report_reader) where possible and never expose columns the caller may not see (masking applies).
- Access to each report is governed by its own permission.
