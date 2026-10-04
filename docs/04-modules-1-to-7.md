# File 4 of 6: Part 10, Modules 1 to 7

# PART 10. MODULE SPECIFICATIONS

For EVERY module implement: repositories, services, controllers, routes, validation schemas, policies, permission codes, audit behavior, tests and OpenAPI docs. Each description says what the module must do, its rules, main flows and endpoints (grouped by resource). Add any additional endpoints that are clearly needed. Every endpoint is authenticated, permission-protected, rate-limited and validated unless stated otherwise.

Note: the numbering below follows the build order, not the client's original list.

## MODULE 1: USERS, ROLES AND PERMISSIONS (build first, everything depends on it)

Purpose: identity, access control and audit.

- Auth endpoints: login, refresh, logout, logout all, change password, forgot password, reset password, current user profile (me), current user permissions.
- Users: create (linked to exactly one staff, guardian or student record according to user type), list with filters (type, active, role, search), view, update, activate and deactivate, unlock, reset password, assign and remove roles. Bulk creation of guardian accounts from existing guardians (generate usernames, temporary passwords, and a distribution file or notification), and bulk creation of student accounts.
- Roles: create, rename (not system roles), delete (not system roles, and not if assigned), list, view with permissions, assign permission sets.
- Permissions: read-only list grouped by module (managed by the seed process, not by users).
- Audit logs: read-only search by user, table, record, action and date range, with keyset pagination. No update or delete endpoints exist at all.
- Settings: key-value settings grouped by area, including school profile (name, logo path, address, contact, currency, receipt prefix and footer text, print templates). Read for authorized users, write only for admin. Sensitive settings (for example gateway keys) are never returned in plain form.

Rules:
- Exactly one linked person per non-admin user, matching the user type (the database also enforces this).
- Usernames are unique, case-insensitively in practice. Normalize before storing.
- Protect the last Super Admin. System roles are immutable.
- Any role or permission change clears affected permission caches and revokes or refreshes affected sessions as appropriate.

## MODULE 2: ACADEMIC SETUP

Purpose: the structure everything else hangs on.

- Academic years: create, list, view, update, set current (exactly one current year at any time, switch atomically in a transaction), close a year (makes it read-only, requires preconditions such as all report cards published, all fees for the year paid or carried forward, promotions decided). Provide a closing pre-check endpoint that reports what is blocking closure.
- Terms: belong to a year, with non-overlapping and in-year date validation.
- Classes: name and level order, ordered list.
- Sections: belong to a class, with capacity and a class teacher. Show current strength versus capacity.
- Subjects: code, name, type.
- Class-subject mapping: which subjects each class studies, mandatory or elective.
- Subject-teacher assignment: per year, section and subject, which staff member teaches it.
- Rooms: also used by exams and timetable.

Rules:
- Soft delete for classes, sections and subjects; refuse deletion if referenced by active data.
- Cannot lower a section's capacity below its current enrollment.
- A teacher's assignments define their authorization scope for attendance and marks (feed into the policy layer, with caching).
- "Copy setup from previous year" operation clones subject-teacher assignments, fee structures and class-subject mappings as drafts for review.

## MODULE 3: STUDENT MANAGEMENT

Purpose: the complete lifecycle of a student from enquiry to leaving.

- Admission applications: create (reception-entered enquiry), list and search, view, update, move through the status workflow (enquiry, applied, test, accepted, rejected, enrolled). Illegal transitions rejected. Converting an accepted application into a student is ONE atomic transaction: create the student, create or link guardians, create student-guardian links, create the first enrollment for the chosen year and section with the next free roll number, generate the first invoices (admission fee and first period fees), link the application to the student, and optionally create portal accounts. If any step fails, everything rolls back.
- Students: create directly (for transfers-in), list with filters (class, section, status, gender, year, guardian phone), search (Part 9.1), full profile (personal data, guardians, current enrollment, documents, health, discipline, fee status summary, attendance summary), update, soft delete (only if no financial or academic history, otherwise use status changes), restore.
- Guardians: create, search by phone or national ID (to link an existing guardian when siblings are admitted), update, view all linked children. Enforce one primary guardian per student and at least one fee payer guardian.
- Sibling detection and linking through shared guardians. Use siblings to offer the sibling discount automatically for review.
- Student documents: upload, list, download, soft delete, with type and size restrictions.
- Enrollments: enroll a student in a year, class and section. Roll numbers are the next free number in the section (safe under concurrency, using a lock on the section), with an operation to re-sort roll numbers alphabetically. Transfer a student between sections (keeps history, adjusts roll number, moves future invoices only if configured).
- Promotions: bulk promotion workflow for year end. The user selects a class and year, the system proposes results (promote, detain, graduate) based on configurable rules (for example pass status from results), the user reviews and edits, then the system executes in a background job: creates next-year enrollments with roll numbers, records promotion rows, marks old enrollments, graduates the final class. Re-runnable safely, with a summary report.
- Leaving and certificates: record withdrawal or transfer, generate the leaving certificate number (database sequence), update student status, close active transport, cancel or settle open invoices according to explicit choices, and produce printable certificates (leaving, character, bonafide, fee clearance) as PDFs from configurable templates.
- Student ID cards: printable cards (single and batch).
- Health and discipline records: create, list, update. Sensitive: restrict by permission, encrypt sensitive fields at the application level, and log every read of health records in the audit log.
- Import: bulk import students and guardians from a spreadsheet, with a dry-run validation step returning per-row errors and duplicate warnings before anything is saved, then a confirmed import as a background job with a result report.

Rules:
- Admission numbers come from the database sequence.
- A student has at most one enrollment per year; roll numbers are unique within section and year.
- Sections must belong to the chosen class (the database enforces this; the API validates first for a friendly error).
- Never hard delete a student who has any history.
- Photo upload follows Part 5.8.

## MODULE 4: ATTENDANCE

Purpose: daily student attendance, staff attendance, leave handling and parent alerts.

- Student attendance sheet: get the sheet for a section and date (enrolled students with any existing status). Submit the entire sheet in ONE request as a bulk upsert. Only the assigned class teacher (or a user with an override permission) can mark. Restrict marking to today by default; allow edits to past dates only with a specific permission and an audit reason, within a configurable window.
- No attendance on non-school days: define school calendar days (holidays and weekends) in settings and validate.
- Summaries: per student (monthly and yearly percentage), per section (daily counts), per class, and defaulter lists (below a configurable threshold). Set-based SQL, cached for the current day.
- Staff attendance: manual entry by an authorized user with check-in and check-out times, plus optional self check-in. Monthly summary per staff member feeding payroll (days present, absent, late, half days, unpaid leave).
- Leave types and leave requests: requests for students (by guardian or by staff on their behalf) and staff. Approval workflow (pending, approved, rejected, cancelled) by the right approver (class teacher for students, HR or principal for staff). Approving a student leave marks those dates as leave in attendance. Approving staff leave updates the leave balance in a transaction (reject if insufficient, unless the leave type is unpaid). Cancelling reverses the effect.
- Absentee alerts: after attendance is submitted, emit an event so notifications send an absence message to the primary guardian (deduplicated: one combined message per day per guardian when sensible).

Rules:
- One attendance record per enrollment and date (upsert).
- Marking attendance for a withdrawn or transferred enrollment is rejected.
- Late marking and edits are audited.

## MODULE 5: FEE MANAGEMENT

Purpose: define fees, generate invoices, collect payments, handle dues. The most financially sensitive module. Correctness beats speed.

- Fee categories, fee structures per year, class and category, discounts, student discounts, fine rules: full management with validation (percent limits, date ranges, no duplicates).
- Invoice generation: single invoice, and bulk for a class or the whole school for a billing period (background job). Uses the fee structure, the student's active discounts, and transport fees for that enrollment. Totals are calculated in the service with decimal-safe math so stored totals satisfy the database check (total = subtotal - discounts + fines). One invoice per enrollment per billing period, so generation is idempotent and safe to re-run (skip existing, report skipped). Items stored per category.
- Installment plans: split an invoice into installments with due dates, validate they sum to the invoice total, mark overdue by a nightly job.
- Fines: a nightly job applies fine rules to overdue invoices. Idempotent (never apply the same fine twice for the same day), totals recalculated consistently. Waive-fine action with permission, reason and audit.
- Payments: record a payment for a guardian across one or more invoices. In one transaction: lock target invoices in ascending id order, validate the payment does not exceed outstanding balances, decide allocation (automatic oldest-due-first, or manual), insert the payment, insert allocations whose sum exactly equals the payment amount, let the database recompute invoice paid totals and statuses, emit a payment-recorded event, return the receipt. Receipt number comes from the database sequence. Support cash, bank, online and cheque, with bank account required for bank and cheque.
- Payment reversal: never edit or delete a payment. A reversal needs a specific permission and a reason, marks the payment reversed, and the database recalculates invoices. Accounting posts an offsetting entry through the event.
- Receipts: printable receipt PDF (and thermal-printer-friendly format, reusing the idea from the old POS) using school profile settings. Reprints are marked as duplicate copies and logged.
- Family view: all children's outstanding dues together, payable in one go.
- Defaulters and dues: overdue invoices with filters (class, section, days overdue, amount), aging buckets (0-30, 31-60, 61-90, over 90 days), and reminders through the notification module with rate limits.
- Concessions: discount approval workflow (request, approve by an authorized user, with validity dates).
- Carry-forward at year end: unpaid balances carried to the next year as an explicit opening-balance invoice item, fully auditable.
- Daily collection report and cashier closing: total collected by method and by cashier for a date.
- Online payment gateway: design behind an interface (strategy) with webhook handling that verifies signatures, is idempotent, and records the payment once. Implement a stub or disabled adapter now and document how to add a real provider.

Rules:
- Money uses fixed-precision decimals end to end.
- Overpayments are REJECTED.
- Cancelled invoices cannot receive payments. Cancelling an invoice with valid payments is blocked until the payments are reversed.
- Only the collect permission can record payments; only the reverse permission can reverse.
- Every payment, reversal, waiver and discount approval writes to the audit log.
- Rate-limit and idempotency-protect payment endpoints.

## MODULE 6: EXAMINATIONS AND RESULTS

Purpose: schedule exams, capture marks, compute grades and ranks, publish report cards.

- Exam types, exams (per year and term), exam schedules (per class and subject with date, time, room, total and passing marks). Validate that subjects belong to the class, that a room is not double-booked at the same date and time, and that a class does not have two overlapping papers.
- Datesheets: printable datesheet per class.
- Admit cards: per student or per class. Block generation for students with dues beyond a configurable threshold if the school enables that policy (feature flag, OFF by default).
- Marks entry: the assigned subject teacher gets the marks sheet for a schedule and submits it in one bulk upsert, with per-row validation (not above total marks, absent flag consistent with empty marks). Spreadsheet upload option with a dry run. Track who entered marks. Editing is possible until the exam is locked. After locking, only an unlock action with a special permission and reason can reopen it.
- Grading scales and ranges: manage scales, keeping ranges non-overlapping and covering 0 to 100 (validate coverage gaps in the service and warn).
- Result computation: per-student totals, percentage, grade (binary search over sorted ranges), pass or fail per subject and overall, rank within section and class (with proper tie handling). Run as a job for big classes, store into report cards, repeatable. Recomputing allowed only while the exam is not locked.
- Publishing: exam status workflow draft, published, locked. Publishing report cards makes them visible to guardians and students and triggers a notification event. Locking freezes everything.
- Report cards: single and bulk PDF generation with school branding, subject-wise marks, grades, remarks, attendance summary for the period, and rank. Bulk generation is a job with a downloadable archive.
- Analysis: subject-wise average, highest and lowest, pass percentage, grade distribution, top N students, and comparison across exams for the same student.

Rules:
- Marks cannot exceed total marks and cannot change after locking (database triggers also enforce it).
- One marks row per schedule and enrollment.
- Teachers only see and edit their own subjects and sections, unless they have the override permission.
- Report card visibility to guardians depends on published state and (optionally) on the fee clearance policy flag.

## MODULE 7: STAFF AND HR

Purpose: staff records and everything about their employment.

- Departments and designations.
- Staff: create (employee number from the sequence), list, search, view, update, deactivate (resigned or terminated with date and reason; blocks future assignments and disables the linked user, but preserves history), soft delete only when no history.
- Staff documents: upload and manage, with confidentiality restrictions.
- Contracts: create with non-overlapping active periods per staff member (validate before the database does), expiry tracking, and a reminder job for contracts that will end soon.
- Leave balances per staff, type and year: allocate at the start of a year (bulk, from leave type defaults), view, and adjust with audit. Balances update through the attendance module's leave approval.
- Staff self-service: view own profile, contract summary, leave balances and payslips.
- Teacher workload view: assigned sections and subjects, periods per week from the timetable.

Rules:
- Sensitive fields (national ID, salary, bank details) are encrypted at the application level and shown only to permitted roles. Masked by default in list responses.
- Only HR permission holders can see other staff members' contract and salary data.
