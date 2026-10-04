# PROJECT BRIEF: SCHOOL MANAGEMENT SYSTEM (SINGLE CAMPUS) BACKEND
## File 1 of 6: Parts 1 to 4 (Context, Working Rules, Abandoning Milk POS, Architecture)

# PART 1. CONTEXT AND MISSION

I am converting an old Milk POS application into a full School Management System (a school ERP). The old Milk POS business logic is being ABANDONED completely. Only the technical foundation may be reused if it is good: the framework, project setup, tooling, and generic utilities. Everything domain-specific to milk (products, milk collection, dairy customers, milk billing, and so on) must be removed.

The PostgreSQL database has already been designed and created. It is the source of truth. The local database has been synced to match the cloud database. Do not redesign the schema. Read the actual schema from the database itself (tables, columns, constraints, triggers, indexes) and build the application around it. If you believe a schema change is needed, stop and propose it to me first. Do not silently change it.

The system is single campus. Do not add multi-branch logic anywhere.

Your job is to design and build the complete backend: repositories, services, controllers, routes, middleware, authentication, authorization, rate limiting, validation, error handling, caching, background jobs, tests, and API documentation for all modules listed below. A frontend is out of scope for now, but the API must be clean enough that a web app and a mobile app can consume it.

Modules in scope (final list agreed with the client):
1. Student Management
2. Academic Setup
3. Attendance
4. Fee Management
5. Examinations and Results
6. Staff and HR
7. Payroll
8. Timetable
9. Accounting
10. Inventory
11. Library
12. Transport
13. Parent, Student and Teacher Portals (plus notifications)
14. Reports and Analytics
15. Users, Roles and Permissions

Explicitly OUT of scope: front office and visitors, hostel, school shop or POS, homework and assignments, online classes, alumni, counseling, co-curricular extras, and a general communication module beyond notifications.

# PART 2. HOW YOU MUST WORK

This is a large task. Work in phases. Follow the status and stop conditions in 00-README-INDEX.md.

Rules for working:
1. Inspect the existing project. Detect the language, framework, ORM or query builder, package manager, folder structure and test setup. Keep the existing stack unless it is clearly unsuitable.
2. Build module by module in the order given in Part 16. After each module, run its tests and summarize what was built, the endpoints, and any open questions.
3. Whenever a business rule is ambiguous and not covered by the approved defaults, ask me. Group your questions and ask them together.
4. Never hardcode secrets. Never log secrets, passwords, tokens, or national ID numbers.
5. Keep every change small, readable, and consistent with the conventions established in Phase 1.
6. Write short comments only where the reason is not obvious. Explain why, not what.

# PART 3. ABANDONING THE MILK POS CODE

1. Scan the whole codebase and list every file, model, route, controller, service, migration, seeder, test, config entry, environment variable and dependency that belongs to the Milk POS domain.
2. Present the list to me before deleting anything. Work on a branch so the old code stays recoverable.
3. Old migrations: since the database already exists and is the source of truth, baseline the current schema as migration 001 (or introspect it) and discard old milk migrations.
4. Remove unused dependencies afterward, and update the README, environment example file and scripts so nothing refers to milk anymore.
5. Reuse only what is generic and good: login mechanics if sound, a base HTTP setup, printing or receipt utilities. Review each reused piece for security and quality before keeping it. Do not assume old code is trustworthy.

# PART 4. ARCHITECTURE AND OBJECT-ORIENTED DESIGN

Strict layered architecture. Each layer only talks to the layer directly below it.

Layers, top to bottom:
1. Routes: map URL and HTTP method to a controller method, and attach middleware (authentication, permission check, rate limit, validation). No logic.
2. Controllers: thin. Read the validated request, call one service method, shape the HTTP response. No business rules, no database access.
3. Services: all business logic and rules, orchestrate multiple repositories, manage transactions, emit domain events, call other services when a workflow crosses modules.
4. Repositories: the only layer that talks to the database. Queries only, no business rules.
5. Database: PostgreSQL, with its constraints and triggers as the last line of defense.

Supporting building blocks:
- DTOs or schemas: separate input schemas, output schemas and internal domain objects. Never expose raw database rows, and never let the client set fields it should not control (status, totals, created_by, ids).
- Mappers: convert between database rows, domain objects and API responses.
- Domain errors: a hierarchy of custom error classes (validation, not found, conflict, forbidden, unauthorized, business rule violation, rate limited, and so on), each with an error code and an HTTP status.
- Events: an internal event dispatcher so modules stay decoupled. For example, when a payment is recorded, accounting creates a voucher and notifications send a receipt message.

Object-oriented requirements (reusability is a priority):
1. Abstract BaseRepository with generic operations: find by id, find one by criteria, find many with filters, paginated list, create, bulk create, update, soft delete, restore, exists, count. Concrete repositories extend it and add only module-specific queries.
2. Abstract BaseService with common behavior: CRUD delegation, hooks before and after create or update, transaction handling, consistent not-found handling.
3. BaseController with standard handlers for list, get, create, update, delete, and shared helpers for pagination and response formatting.
4. Composition and dependency injection: services receive repositories and other services through constructors, never by importing globals. Use a simple container or a manual composition root that wires everything in one place.
5. Interfaces or abstract contracts for anything with multiple implementations: notification channels (SMS, WhatsApp, email, in-app), file storage (local disk now, cloud later), payment gateways, cache stores, rate-limit stores, job queues. Use the strategy pattern.
6. Use these patterns where they genuinely fit, not for decoration: Repository, Service Layer, Unit of Work, Strategy (notification channels, fee calculation, grading, fine and discount rules), Factory (notification sender, report exporter), Observer or event bus, Template Method (base service hooks, report pipeline), Builder (dynamic query filters, invoice construction), and State pattern for status workflows (invoice, exam, payroll run, leave request, admission application). Each state machine defines allowed transitions explicitly and rejects illegal ones.
7. Keep classes small and single-purpose. Favor readability over cleverness.

Folder organization (adapt to the framework): one folder per module containing its routes, controller, service, repository, schemas and tests; a shared core folder for base classes, middleware, errors, utilities, config, database access, cache, queue, events and logging.
