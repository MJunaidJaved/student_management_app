# SCHOOL MANAGEMENT SYSTEM BACKEND: BRIEF INDEX

Place this whole `docs` folder at `POS/docs/`. Read the files in this exact order, in full:

1. 00-README-INDEX.md (this file: status and approved decisions)
2. 01-context-architecture.md (Parts 1 to 4)
3. 02-cross-cutting-auth-security.md (Parts 5 to 8)
4. 03-algorithms-performance.md (Part 9)
5. 04-modules-1-to-7.md (Part 10, Modules 1 to 7)
6. 05-modules-8-to-15.md (Part 10, Modules 8 to 15)
7. 06-flows-checklists-phases.md (Parts 11 to 17)

The last heading of the last file is "END OF BRIEF". If you do not reach it, a file is missing or cut off: stop and tell me.

## CURRENT STATUS (overrides any older "wait for approval" wording inside the files)

- Phase 0 is APPROVED.
- Phase 1 (foundation) is COMPLETE and verified.
- Anon and authenticated database roles have been revoked in Supabase.
- Continue from Phase 2 through Phase 11 without stopping between phases, except in the stop conditions listed below.
- Ignore any line inside these files that says "do not write code until Phase 0 is approved". It is superseded.

## APPROVED DECISIONS (replace every "ask me" item in the brief)

1. Overpayments: reject them. No advance credit, no schema change.
2. Cache, rate limiter, job queue: in-process for now, behind interfaces so Redis can replace them without touching modules. Document that these must move to Redis before running more than one server instance.
3. Lockfile: remove package-lock.json from .gitignore and commit it.
4. Row-level security stays DISABLED. Ownership is enforced only in the service and policy layer. Replace any RLS tests with policy-layer tests: a guardian must never read another family's data, a teacher must never act on a section that is not theirs, out-of-scope records return 404. Do not re-enable RLS.
5. Approved schema additions (as versioned migrations): a table for hashed refresh tokens (user, token family, hash, expiry, revoked flag, user agent, IP); the pg_trgm extension and the trigram and prefix indexes needed for student, guardian, staff and book search; any other index proven necessary by a measured query plan. Any other schema change (new table, new column, public identifier column, notification preferences table): propose and wait.
6. Milk POS removal: on the branch, in one separate commit. Show the file list first, then do it after Phase 2 is finished.
7. Business rule defaults (store each in settings so they can change without code changes):
   - Transport fee: full month if allocation starts on or before the 15th, otherwise starts next month.
   - Staff absence deduction: unpaid absent days times (monthly salary divided by 30).
   - Fine cap: a fine on one invoice cannot exceed 50 percent of the invoice subtotal.
   - Purchase orders: allow partial receiving.
   - Book reservations: not built.
   - Fee-clearance policy for admit cards and report cards: implemented, OFF by default (feature flag).
   - Two-factor authentication: not built now, but design the auth flow so it can be added.
   - Public admission enquiry form: not built now.
   - SMS and WhatsApp: adapter stubs only. In-app and email fully working.
   - Currency and language: read from settings, English output only.
8. Database role: development may keep the current connection, but before the final phase create or use a limited application role (app_user) and switch the app to it. The app must not run as postgres or a superuser in production. Migrations and seeding use a separate privileged connection. Database roles app_user, report_reader and backup_user exist; their passwords must be changed from the CHANGE_ME defaults and stored in environment variables.

## STOP AND ASK ONLY WHEN

- A schema change is needed beyond what is approved above.
- A business rule is ambiguous and not covered by the defaults.
- Something destructive or irreversible is about to happen.
- A test or verification fails and cannot be fixed after honest attempts.

## DEFINITION OF "FINISHED" FOR EVERY PHASE

- Repositories, services, controllers, routes, validation schemas, policies, permission codes, audit behavior and OpenAPI docs are done for every module in the phase.
- Unit tests, integration tests against the real schema, and API tests pass.
- Typecheck and lint are clean.
- Every route declares authentication, permission, ownership policy, rate-limit tier and validation schema.
- Commit after each module on the feat/school-management-backend branch.
- Report only what was actually run: real test output, real query plans, real timings.

## FINAL DELIVERABLES

1. Full API with OpenAPI documentation.
2. All migrations, seeds, and the Milk POS removal commit.
3. Security checklist from Part 13, marked item by item with evidence (adjusted for RLS being disabled).
4. Test summary: unit, integration, API, concurrency, idempotency, performance.
5. README: setup, environment variables, migrations, seeding, workers, tests, folder structure. Include a warning never to re-grant USAGE on schema public to anon or authenticated.
6. A list of everything stubbed, deferred or needing my decision.
7. A production-readiness checklist (limited DB role, Redis before multiple instances, secrets management, backups, HTTPS).
