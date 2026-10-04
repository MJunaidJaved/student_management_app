# File 2 of 6: Parts 5 to 8 (Cross-Cutting Concerns, Authentication, Authorization, Rate Limiting)

# PART 5. CROSS-CUTTING CONCERNS

5.1 Configuration
- All configuration comes from environment variables, validated at startup. The app refuses to start if a required value is missing or malformed. Provide an example environment file with no real secrets.
- Separate settings for development, test and production.

5.2 Database access
- Connection pool with sensible limits and timeouts. Parameterized queries only. Never build SQL by concatenating user input.
- Transaction helper (Unit of Work) so a service can run several repository operations atomically with automatic rollback on error.
- The database has audit triggers that read session variables. At the start of every request's database work, inside the same transaction and connection, set transaction-local values: current user id, current user type (admin, staff, guardian, student), and current guardian id (when the user is a guardian). Build this into the transaction helper so no developer can forget it. These values must never leak between requests on pooled connections.
- Set statement timeouts and lock timeouts.
- Handle serialization failures and deadlocks with a limited automatic retry where needed.

5.3 Standard API conventions
- Base path with version prefix (/api/v1).
- Resource-oriented plural nouns, standard HTTP methods and status codes (200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500).
- One consistent success envelope and one error envelope. Errors carry a machine-readable code, a human message, and field-level details for validation failures. Never leak stack traces or SQL details.
- Every response carries a request id, also written in logs.
- ISO 8601 UTC dates. Money returned as fixed-precision decimal strings, never floating-point numbers. All money math is decimal-safe.

5.4 Validation
- Validate every input (body, query, path params, headers) with a schema library at the route level before it reaches the controller. Reject unknown fields. Enforce types, lengths, ranges, formats (dates, phone numbers, national ID formats, emails) and enums matching the database CHECK constraints.
- Validation errors return 422 with field-level messages.
- Sanitize text to prevent stored injection and script content. Escape on output where relevant.

5.5 Pagination, filtering, sorting and search (shared by all list endpoints)
- Default to keyset (cursor) pagination for large, growing tables (attendance, audit logs, payments, invoices, marks, notification logs, stock movements). Offer offset pagination only for small bounded tables (classes, sections, subjects, roles).
- Enforce a maximum page size. Return next cursor and has-more flag. Provide total counts only on request.
- Filters use an allow-list of fields per endpoint. Sorting uses an allow-list of sortable columns backed by indexes. Reject anything else.
- A reusable query builder turns validated filter parameters into safe parameterized conditions.

5.6 Error handling and logging
- Global error handler converts domain errors into the standard envelope and maps database errors to meaningful application errors (unique violation becomes conflict, foreign key violation becomes a clear message, check violation becomes validation or business-rule error, trigger exceptions such as locked marks, closed academic year, unbalanced voucher become business-rule errors with friendly messages).
- Structured JSON logging with levels. Log request id, user id, route, latency and status. Never log sensitive fields. Keep separate security logs for login events and permission denials.

5.7 Idempotency
- Any endpoint that creates money-related records (payments, payroll runs, invoice generation) supports an idempotency key header so a retried request does not create duplicates. Store keys with the resulting response for a limited time.

5.8 Files and uploads
- Student photos, staff photos and documents go through a storage abstraction (local disk now, cloud later). Enforce a file type allow-list (verify by content, not only extension), a size limit, random stored file names, and no execution permission. Store only the path in the database. Serve files through authenticated endpoints, never as public static files. Never trust the client file name.

5.9 Background jobs and scheduling
- Job queue for slow or scheduled work: bulk invoice generation, bulk notifications, report exports, payroll generation, nightly fine calculation, overdue installment marking, absentee alerts, backup reminders, document expiry reminders (driver license, vehicle insurance and fitness).
- Jobs are idempotent, retried with backoff, logged, with a dead-letter store for repeated failures.

5.10 Caching
- In-process cache for small, rarely changing reference data (roles and permission maps, settings, classes, sections, subjects, grading scales, fee categories, current academic year). Sit behind an interface so a shared cache such as Redis can replace it.
- LRU eviction with a maximum size and a TTL per key type. Invalidate explicitly when underlying data changes (for example, when a role's permissions change, clear that role's cached permission set). Never cache user-specific sensitive data without scoping the key to the user.
- Cache the current academic year and the permission set per user.

5.11 Documentation
- Generate OpenAPI documentation for every endpoint, including auth requirements, required permissions, request and response shapes, and error codes. Keep it generated from the schemas so it never drifts.

# PART 6. AUTHENTICATION

Users are of four types: admin, staff, guardian, student. Every non-admin user is linked to exactly one person record (staff, guardian or student). Admins may have none.

6.1 Login and credentials
- Passwords hashed with a modern, slow, salted algorithm (argon2 preferred, bcrypt fallback) with tuned cost. Never store or log plain passwords. Enforce a password policy (minimum length, common or breached password rejection, no reuse of the current password).
- New accounts are created with a temporary password and the must-change-password flag. Until changed, the only permitted actions are change password and logout.
- Login accepts username (optionally email or phone). Responses must not reveal whether the username or password was wrong (one generic message), with similar timing either way to reduce user enumeration.
- Track failed attempts. After a configurable number of failures, lock the account for a period using the locked-until field, and record events in the audit log. Reset the counter on success. Provide an admin unlock action.

6.2 Tokens and sessions
- Short-lived access tokens (for example 15 minutes) and longer-lived refresh tokens. Sign with a strong secret or key pair from environment configuration, and include token id, user id, user type, issued and expiry times. Do not put the full permission list in the token. Load permissions server-side from cache so role changes take effect quickly.
- Refresh tokens are rotated on every use, stored hashed server-side, tied to a device or session record, and revocable. Reusing an already-used refresh token means theft: revoke the whole token family and force re-login. This uses the approved refresh-token table (see 00-README-INDEX.md).
- Provide logout (revoke current session), logout-all (revoke all of the user's sessions), and an access-token denylist for immediate revocation when a user is deactivated or a password is changed.
- Deactivating a user or changing their password invalidates existing sessions.
- If cookies are used, they must be HttpOnly, Secure and SameSite. If tokens are used in headers, document how the client must store them.

6.3 Account recovery
- Password reset by a one-time, short-lived, single-use token sent to the registered email or phone, stored hashed. The response must not reveal whether the account exists. Rate-limit heavily.
- Admin-initiated password reset generates a new temporary password and sets the must-change flag.

6.4 Optional hardening (design so it can be added later, not built now)
- Two-factor authentication for admin and accountant roles.

6.5 Audit of authentication
- Record logins, failed logins, logouts, lockouts, password changes and password resets in the audit log with IP address and user agent.

# PART 7. AUTHORIZATION (ACCESS CONTROL)

Authorization has THREE independent checks. All three must pass.

1. Permission check (RBAC): the user must hold the permission code required by the endpoint (for example fees.collect, students.create, marks.enter). Permissions are grouped by module and stored in the database. Roles are collections of permissions, a user can have multiple roles, and the effective set is the union. Build a permission service with cached lookup and an authorization middleware that takes the required permission code. Deny by default: an endpoint with no declared permission must not be reachable. Provide a startup check that fails if any protected route lacks a declared permission. Seed the full permission list from the endpoints you build, and seed default roles (Super Admin, Principal, Teacher, Accountant, Librarian, Guardian, Student) with suitable permission sets for my review.

2. Ownership and scope check (row-level rules). Row-level security in the database is DISABLED, so this layer is the only barrier and must be built with extra care.
   - A guardian may only see data of students linked to them through the student-guardian link (profile, attendance, invoices, payments, marks, report cards, transport, library issues, notifications). Never any other student.
   - A student may only see their own data.
   - A teacher may only mark attendance and enter marks for sections and subjects assigned to them (subject teachers and class teacher assignments), and only view students of those sections.
   - Staff may only see their own payslips, leave balances and attendance, unless they hold an HR or payroll permission.
   - The class teacher of a section can see broader information about that section.
   Enforce this in the service layer using a reusable policy component (one policy class per resource, with methods such as can view, can edit). Never trust ids sent by the client. Always verify the record belongs to the caller's scope, to prevent insecure direct object references. Return 404 rather than 403 for records outside the caller's scope so existence is not revealed.

3. State check: some actions are only allowed in certain states (no editing marks after the exam is locked, no changing approved payroll, no editing posted vouchers, no changes to a closed academic year, no paying a cancelled invoice). The service layer checks these and returns clear business-rule errors. Database triggers enforce them again as a safety net.

Extra rules:
- Sensitive actions (reverse a payment, waive a fine, approve a discount, lock exams, approve payroll, post a voucher, deactivate a user, change roles) require specific permissions and always write to the audit log with a mandatory reason where applicable.
- Segregation of duties: the person who creates payroll should not approve it, and the person who creates an expense should not approve it (configurable). Enforce in the service.
- Super Admin is protected: it cannot be deleted, and the last Super Admin cannot be deactivated or demoted.
- System roles cannot be deleted or renamed.

# PART 8. RATE LIMITING AND ABUSE PROTECTION

Layered rate limiting behind an interface (in-process store now, Redis later). Use a sliding window or token bucket algorithm. Return 429 with a retry-after header and the standard error envelope.

Tiers:
1. Global limit per IP for all traffic.
2. Strict limit per IP and per username on login, refresh, password reset and any OTP endpoint. Add progressive delays after repeated failures. Combine with account lockout.
3. Per authenticated user limits for normal API usage, higher for staff and admin, lower for guardian and student accounts.
4. Tight limits on expensive endpoints: report generation and exports, bulk operations, search, file uploads, bulk notifications, PDF generation, and anything that triggers heavy queries.
5. Limits on write operations that create money records.
6. Notification sending limits to protect against SMS and WhatsApp cost abuse.

Other protections:
- Request body size limits, request timeouts, limits on the number of items in bulk requests.
- Security headers, strict CORS with an allow-list of origins from configuration, no wildcard in production.
- CSRF protection if cookies are used for authentication.
- HTTPS enforcement and proxy trust configuration in production.
- Protection against mass assignment (allow-listed fields only), prototype pollution, path traversal in file handling, and server-side request forgery in any URL-fetching feature.
- Brute-force protection on any endpoint that checks a secret.
- Health check endpoints that reveal nothing sensitive.
