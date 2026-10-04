# File 6 of 6: Parts 11 to 17 (Flows, Endpoint Rules, Security Checklist, Testing, Operations, Phases, Questions)

# PART 11. HOW THE MODULES WORK TOGETHER (12 END-TO-END FLOWS TO IMPLEMENT AND TEST)

1. New admission: enquiry to application to test to accepted to enrolled. Result: student, guardian links, enrollment with roll number, first invoices, optional portal accounts, a welcome notification, and audit entries.
2. Monthly billing cycle: a job generates invoices for all active enrollments using fee structure, discounts and transport fees. Guardians receive notifications. A nightly job marks overdue installments and applies fines. Reminders go out. Payments come in and are allocated. Receipt vouchers post in accounting. Reports show collection and aging.
3. Sibling payment: one guardian pays for two children in one transaction with allocations across both children's invoices. Receipt shows the breakdown. Reversal restores both invoices correctly.
4. Daily attendance: teacher submits the section sheet, the database is updated in one bulk operation, absentees' guardians are notified in a combined message, leave requests approved earlier show as leave, summaries update.
5. Exam cycle: create exam and schedules, generate datesheets and admit cards (with the optional dues policy), teachers enter marks, results compute with grades and ranks, principal reviews and publishes, guardians receive notifications and can view report cards, then the exam is locked.
6. Year-end: closing pre-check, promotions in bulk with review, carry-forward of dues, new year setup copied from the old year, old year closed and read-only.
7. Payroll cycle: staff attendance and leave data feed the run, payslips are generated and reviewed, a different user approves, payment is marked, accounting vouchers post, staff view their payslips in the portal.
8. Teacher absence: staff leave approved, affected timetable slots identified, substitutes suggested and assigned, substitutes and class notified.
9. Purchasing to stock: purchase order created, received (fully or partially), stock movements written, low-stock alerts cleared, expense or liability voucher posted.
10. Student leaving: withdrawal recorded, transport ended, dues settled or cancelled per choice, certificates generated, account deactivated, status updated, history preserved.
11. Library cycle: issue with availability lock, overdue detection, fine generation, fine payment linked to a payment, clearance.
12. Security scenarios: a guardian attempting to read another family's data, a teacher attempting to mark a section that is not theirs, a locked account, token theft via refresh-token reuse, and repeated login attempts hitting the rate limit. All must fail safely and be logged.

# PART 12. ENDPOINT DESIGN RULES

- Group routes by module and by audience: admin and staff routes under module paths, portal routes under portal paths (guardian, student, teacher).
- Each endpoint definition declares: HTTP method and path, required authentication, required permission code, ownership policy, rate-limit tier, validation schema, success response schema, and possible error codes. Keep these declarations next to the route so they are easy to audit.
- Write endpoints return the resulting resource. Action endpoints that change state are verbs on the resource (approve, reject, publish, lock, reverse, close, promote), use POST, and are idempotent where money or state is involved.
- List endpoints always paginate, filter and sort as in Part 5.5.
- Bulk endpoints accept a bounded array, return per-item results (which succeeded, which failed and why), and run atomically or in a documented partial-success mode.
- Public identifier columns for receipts and certificates are a schema change: propose before adding.
- Provide a public verification endpoint for certificates and receipts by number, returning only minimal validity information, heavily rate-limited.
- Provide health and readiness endpoints for deployment.

# PART 13. SECURITY CHECKLIST (VERIFY AT THE END, MARK EACH ITEM DONE OR NOT DONE WITH EVIDENCE)

- Every route requires authentication except the explicit public list: login, refresh, password reset request and confirm, health, certificate and receipt verification.
- Every non-public route declares a permission and an ownership policy.
- No raw SQL built with string concatenation anywhere. All queries parameterized.
- Passwords hashed, tokens rotated, sessions revocable, lockout active.
- Sensitive fields encrypted or masked and never written to logs.
- Rate limits and body size limits active on every route group.
- Security headers, CORS allow-list and HTTPS settings configured.
- Uploads validated by content and stored outside any public directory.
- Audit logs written for all sensitive actions, and the database audit triggers receive the session variables.
- Database roles used correctly: the application connects as the limited application role, reporting uses the read-only role, migrations use a separate privileged role, and no application code needs superuser rights.
- anon and authenticated roles have no grants and no USAGE on schema public (already revoked). README warns never to re-grant it.
- Dependency audit run, no known critical vulnerabilities, lockfile committed.
- Error responses leak nothing internal.
- Row-level security is DISABLED by decision. Instead, verify with policy-layer tests that a guardian cannot read another family's rows, a teacher cannot act on another teacher's section, a student cannot read another student's data, and out-of-scope records return 404. Because nothing sits behind the policy layer, review every repository method that takes a record id from the client.

# PART 14. TESTING AND QUALITY

- Unit tests for services with mocked repositories: business rules, state transitions, calculations (fees, fines, discounts, payroll, grades, ranks, allocation), and policy checks.
- Integration tests against a real PostgreSQL test database created from the actual schema: repositories, transactions, constraints, and triggers (locked marks, immutable payments, unbalanced vouchers, closed years, capacity).
- API tests through HTTP for every endpoint group: authentication required, permission denied, ownership denied, validation errors, rate-limit responses, happy path.
- Concurrency tests: two simultaneous payments on the same invoice, two simultaneous bookings for the last library copy, two simultaneous roll number assignments, two simultaneous stock issues. Confirm no double-spend and no over-issue.
- Idempotency tests: repeated payment request with the same key, re-running invoice generation, re-running fine application.
- Performance checks: seed realistic volumes in a throwaway schema (dropped afterward, never in the real database) and measure key queries (student search, attendance sheet submit, invoice generation, dues list, dashboards). Show query plans for the important ones, confirm indexes are used, report timings.
- Coverage: aim high on services and policies.
- Linting and formatting enforced, and a CI workflow definition that runs lint, tests and dependency audit.

# PART 15. OPERATIONS AND DEPLOYMENT NOTES

- README covering setup, environment variables, running migrations, seeding (roles, permissions, default settings, leave types, grading scale), running jobs and workers, running tests, and the folder structure.
- Seed process for a default Super Admin created from environment values with a forced password change on first login.
- Logging, metrics hooks, and graceful shutdown (finish in-flight requests and jobs).
- Backup and restore guidance, a note on point-in-time recovery and monthly restore tests.
- All schema changes go through versioned migrations. Anything beyond the pre-approved list is reviewed by me first.
- CORS origins, trusted proxy and public API domain come from environment configuration, with separate lists for development, staging and production.

# PART 16. BUILD ORDER AND PHASES

Follow the run-through rules in 00-README-INDEX.md: report at the end of each phase, stop only on the listed stop conditions.

Phase 0: Inspect the project, list Milk POS artifacts, implementation plan. (APPROVED)
Phase 1: Foundation: configuration, database access with transaction helper and session variables, base repository, base service, base controller, error hierarchy, response envelope, validation, logging, request ids, pagination and query builder helper, caching, event bus and outbox, job queue, file storage abstraction, rate limiting, security middleware, test scaffolding. (DONE)
Phase 2: Users, roles, permissions, authentication, sessions, settings, audit log endpoints, permission seeding, and the startup check for undeclared route permissions. Show the role-to-permission matrix. Then prepare the Milk POS removal file list.
Phase 3: Academic setup, staff and HR (basic), and student management including admissions, enrollments, guardians, documents, search, import.
Phase 4: Attendance and leave management.
Phase 5: Fee management, payments, receipts, and the accounting event handlers (vouchers) with the outbox.
Phase 6: Accounting module in full, and inventory.
Phase 7: Examinations and results, report cards, and promotions.
Phase 8: Payroll, timetable, library, and transport.
Phase 9: Notifications and portals.
Phase 10: Reports and analytics, exports, dashboards.
Phase 11: Full security review against Part 13, performance pass, documentation, and the 12 end-to-end flow tests from Part 11.

At the end of every phase report: what was built, endpoints with permission codes, real test results, any schema or migration proposals waiting for approval, and open questions.

# PART 17. QUESTIONS (ALL ANSWERED, SEE 00-README-INDEX.md)

1. Stack: keep the existing stack.
2. Overpayments: rejected.
3. Transport proration, absence deduction, fine cap: defaults in the index, stored in settings.
4. Partial PO receiving: yes. Book reservations: no.
5. SMS and WhatsApp: stubs only.
6. Fee-clearance policy: implemented, OFF by default.
7. Two-factor authentication: not now, design for it.
8. Public admission enquiry form: not now.
9. Language and currency: English, currency from settings.
10. Additional tables and indexes: refresh-token table, pg_trgm and search indexes approved. Everything else: propose and wait.

# END OF BRIEF
