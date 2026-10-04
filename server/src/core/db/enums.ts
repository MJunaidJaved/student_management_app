/**
 * The schema's CHECK-constrained value sets, in one place.
 *
 * Part 5.4 requires validation to enforce "enums matching the database CHECK
 * constraints". The schema has no Postgres enum types — every one of these is a
 * `text` column with a CHECK — so there is nothing for the driver to reflect
 * and the lists have to be mirrored in code.
 *
 * Mirrored deliberately in one module rather than inline in each validation
 * schema. Duplicating them per module means a value added to a CHECK gets
 * updated in three places and missed in a fourth, and the symptom is a 422 that
 * the database would have accepted.
 *
 * Verified against the live constraints. If a CHECK changes, change it here and
 * the type error will point at every route that needs revisiting.
 */

export const GENDERS = ['male', 'female', 'other'] as const;

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/** `students.status` */
export const STUDENT_STATUSES = ['active', 'withdrawn', 'transferred', 'graduated'] as const;

/** `student_enrollments.status` */
export const ENROLLMENT_STATUSES = [
  'active',
  'promoted',
  'detained',
  'withdrawn',
  'transferred',
] as const;

/** `admission_applications.status` — the workflow in Module 3. */
export const APPLICATION_STATUSES = [
  'enquiry',
  'applied',
  'test',
  'accepted',
  'rejected',
  'enrolled',
] as const;

/** `subjects.type` */
export const SUBJECT_TYPES = ['core', 'elective', 'co_curricular'] as const;

/** `staff.status` */
export const STAFF_STATUSES = ['active', 'resigned', 'terminated'] as const;

/** `exams.status` — the state machine in Module 6. */
export const EXAM_STATUSES = ['draft', 'published', 'locked'] as const;

export type Gender = (typeof GENDERS)[number];
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export type ExamStatus = (typeof EXAM_STATUSES)[number];

/**
 * Allowed transitions for the admission workflow (Part 4.6, State pattern).
 *
 * Declared explicitly, and anything absent is rejected. Note that `rejected`
 * and `enrolled` are terminal: an enrolled application cannot go back to
 * `accepted`, because a student record now exists and reversing the status
 * would leave the two disagreeing.
 */
export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  enquiry: ['applied', 'rejected'],
  applied: ['test', 'accepted', 'rejected'],
  test: ['accepted', 'rejected'],
  accepted: ['enrolled', 'rejected'],
  rejected: [],
  enrolled: [],
};

/**
 * Allowed transitions for an exam (Module 6).
 *
 * `locked` is reachable only from `published`, and leaving it requires the
 * separate `exams.unlock` permission rather than being a normal transition —
 * which is why `locked` lists nothing here.
 */
export const EXAM_TRANSITIONS: Readonly<Record<ExamStatus, readonly ExamStatus[]>> = {
  draft: ['published'],
  published: ['locked', 'draft'],
  locked: [],
};

/** True when `to` is reachable from `from`. */
export function canTransition<T extends string>(
  map: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): boolean {
  return (map[from] ?? []).includes(to);
}
