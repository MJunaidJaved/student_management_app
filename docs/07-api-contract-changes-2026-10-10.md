# API contract changes — 2026-10-10 verification-closure pass

Not part of the original numbered brief (00–06). This documents a breaking
response-shape change made during backend verification, for whoever builds
the frontend next.

## What changed, and why

While closing test-coverage gaps, several endpoints were found to return the
**raw database row** — snake_case columns — instead of the camelCase shape
every other endpoint in this API returns. Nothing had ever asserted the
actual field names these endpoints returned, so the inconsistency shipped
unnoticed. Each is now mapped to a proper camelCase view, matching the
project's own stated convention ("Return camelCase response objects rather
than raw database rows") and the pattern already used everywhere else
(`toStaffView`, `toYearView`, etc.).

**This is a breaking change to the JSON shape of the endpoints listed below.**
No URL, HTTP method, permission, status code, or business behavior changed —
only field *names* in the response body. No frontend currently consumes these
fields (frontend work is out of scope and was not started), so nothing in
this repository breaks. This table is the contract the frontend must be
built against.

## Before → after, by endpoint

### `GET /academic/terms`, `POST /academic/terms`

| Old field (snake_case) | New field (camelCase) |
|---|---|
| `academic_year_id` | `academicYearId` |
| `start_date` | `startDate` |
| `end_date` | `endDate` |

`id`, `name` unchanged.

### `GET /academic/classes`, `POST /academic/classes`, `PATCH /academic/classes/:id`

| Old field | New field |
|---|---|
| `level_order` | `levelOrder` |

`id`, `name` unchanged.

### `GET /academic/sections`, `POST /academic/sections`, `PATCH /academic/sections/:id`

| Old field | New field |
|---|---|
| `class_id` | `classId` |
| `class_teacher_id` | `classTeacherId` |
| `class_name` | `className` |
| `class_teacher_name` | `classTeacherName` |

`id`, `name`, `capacity`, `strength` unchanged.

### `GET /academic/rooms`, `POST /academic/rooms`

| Old field | New field |
|---|---|
| `room_type` | `roomType` |

`id`, `name`, `capacity` unchanged.

### `GET /academic/classes/:id/subjects`, `PUT /academic/classes/:id/subjects`

| Old field | New field |
|---|---|
| `class_id` | `classId` |
| `subject_id` | `subjectId` |
| `is_mandatory` | `isMandatory` |
| `subject_name` | `subjectName` |
| `subject_code` | `subjectCode` |

`id` unchanged.

### `GET /designations`, `POST /designations`, `PATCH /designations/:id`

| Old field | New field |
|---|---|
| `department_id` | `departmentId` |

`id`, `name` unchanged. (`GET /departments` and its siblings were **not**
affected — `departments` has no field that differed between the two
conventions.)

### `GET /leave-types`, `POST /leave-types`, `PATCH /leave-types/:id`

| Old field | New field |
|---|---|
| `applies_to` | `appliesTo` |
| `days_per_year` | `daysPerYear` |

`id`, `name` unchanged.

### `GET /periods`, `POST /periods`, `PATCH /periods/:id`

| Old field | New field |
|---|---|
| `start_time` | `startTime` |
| `end_time` | `endTime` |
| `sort_order` | `sortOrder` |

`id`, `name` unchanged.

## What did *not* change

Every other endpoint in the system — including the entire Section 3–5
surface (fees, accounting, exams, payroll, inventory, library, transport,
reports) and the rest of Section 1–2 (students, staff, guardians,
attendance, leave requests, timetable entries, substitutions) — was already
returning camelCase and is untouched by this pass. `grading-scales`,
`salary-components`, and `account-heads` were checked specifically (they
were in scope for the same audit) and were already correct; no change was
needed there.

## Verification

Every endpoint above has a regression test asserting the new field name by
name (not just status code), added in commit `46dbff4`. The full suite
(334 tests) passes with these fields under their new names.

## For the frontend

When frontend work starts: build against the camelCase names in this
document, not against any earlier draft, screenshot, or Postman collection
that may have captured the old snake_case shape from these specific
endpoints before this fix.
