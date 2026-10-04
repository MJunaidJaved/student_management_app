/**
 * The ownership and scope layer (Part 7.2).
 *
 * **Read this before adding a policy.** Row-level security is disabled by
 * decision, so there is nothing behind this code. A missing check here is not
 * defence-in-depth weakened — it is an unauthenticated-equivalent data leak,
 * because the database will happily return another family's invoices to
 * whoever asks.
 *
 * Three rules hold everywhere:
 *
 *   1. **Never trust an id from the client.** An id in a path is a request, not
 *      a fact. Every one is checked against the caller's scope before the
 *      record is returned or modified.
 *
 *   2. **Out of scope is 404, never 403.** A 403 on `/students/812` confirms
 *      that student 812 exists, which lets anyone enumerate the roll. The
 *      helpers here throw `NotFoundError` for both "absent" and "not yours" so
 *      the two are indistinguishable from outside.
 *
 *   3. **Scope is derived from the database, not the token.** A token says
 *      "guardian 7"; which children guardian 7 has is a fact about
 *      `student_guardians` that can change between requests. Scope queries run
 *      inside the caller's transaction so they see the same snapshot as the
 *      work they authorise.
 *
 * Scope lookups are cached where they are per-user and stable within a request
 * (a teacher's section list), never where staleness would widen access.
 */

import type { Uow } from '../db/uow';
import type { Actor } from '../db/uow';
import { ForbiddenError, NotFoundError } from '../errors';
import type { CacheStore } from '../cache/cache';
import type { PermissionService } from '../authz/permission-service';

/** What every policy is handed. */
export type PolicyContext = {
  actor: Actor;
  uow: Uow;
  /** Permission codes the caller holds, loaded once per request. */
  permissions: ReadonlySet<string>;
};

/**
 * The reason a check failed, so the caller can pick the right status.
 *
 * `not-found` and `out-of-scope` both become 404; they are distinguished only
 * so logs can tell an enumeration attempt from an ordinary miss.
 */
export type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: 'not-found' | 'out-of-scope' | 'forbidden'; message?: string };

const ALLOW: PolicyResult = { allowed: true };
const outOfScope = (): PolicyResult => ({ allowed: false, reason: 'out-of-scope' });
const notFound = (): PolicyResult => ({ allowed: false, reason: 'not-found' });

/**
 * Turn a result into an error, or return.
 *
 * `entity` names the thing for the 404 message. Note that both failure modes
 * that concern existence produce the *same* error, by design.
 */
export function enforce(result: PolicyResult, entity: string): void {
  if (result.allowed) return;
  if (result.reason === 'forbidden') {
    throw new ForbiddenError(result.message ?? 'You may not do that.');
  }
  throw new NotFoundError(entity);
}

export abstract class BasePolicy {
  constructor(
    protected readonly cache: CacheStore,
    protected readonly permissions: PermissionService,
  ) {}

  /** Admins bypass per-record scope. They do not bypass permission checks. */
  protected isAdmin(ctx: PolicyContext): boolean {
    return ctx.actor.userType === 'admin';
  }

  protected holds(ctx: PolicyContext, code: string): boolean {
    return ctx.permissions.has(code);
  }

  /**
   * The student ids a guardian may see.
   *
   * Not cached. A guardian's children change when a sibling is admitted or a
   * link is corrected, and a stale set here means either a parent cannot see a
   * new child (annoying) or can still see a removed one (a leak). The query is
   * two indexed joins on a handful of rows.
   */
  protected async guardianChildIds(ctx: PolicyContext): Promise<Set<string>> {
    if (ctx.actor.guardianId == null) return new Set();
    const rows = await ctx.uow.many<{ student_id: string }>(
      `SELECT student_id FROM student_guardians WHERE guardian_id = $1`,
      [ctx.actor.guardianId],
    );
    return new Set(rows.map((r) => r.student_id));
  }

  /**
   * The section ids a teacher is assigned to, for the current year.
   *
   * Both routes into a section count: teaching a subject in it
   * (`subject_teachers`) and being its class teacher (`sections`). A class
   * teacher who taught no subject in their own section would otherwise be
   * locked out of marking its attendance.
   *
   * Cached briefly — assignments change at setup time, not during a school day.
   */
  protected async teacherSectionIds(ctx: PolicyContext): Promise<Set<string>> {
    if (ctx.actor.staffId == null) return new Set();

    const ids = await this.cache.getOrLoad(
      'teacher-scope',
      `sections:${ctx.actor.staffId}`,
      async () => {
        const rows = await ctx.uow.many<{ section_id: string }>(
          `SELECT st.section_id
             FROM subject_teachers st
             JOIN academic_years ay ON ay.id = st.academic_year_id
            WHERE st.staff_id = $1 AND ay.is_current
           UNION
           SELECT s.id FROM sections s
            WHERE s.class_teacher_id = $1 AND s.deleted_at IS NULL`,
          [ctx.actor.staffId],
        );
        return rows.map((r) => r.section_id);
      },
    );
    return new Set(ids);
  }

  /** The (section, subject) pairs a teacher may enter marks for. */
  protected async teacherSubjectSlots(ctx: PolicyContext): Promise<Set<string>> {
    if (ctx.actor.staffId == null) return new Set();

    const ids = await this.cache.getOrLoad(
      'teacher-scope',
      `subjects:${ctx.actor.staffId}`,
      async () => {
        const rows = await ctx.uow.many<{ section_id: string; subject_id: string }>(
          `SELECT st.section_id, st.subject_id
             FROM subject_teachers st
             JOIN academic_years ay ON ay.id = st.academic_year_id
            WHERE st.staff_id = $1 AND ay.is_current`,
          [ctx.actor.staffId],
        );
        // Composite key: a teacher may teach maths in 5-A but not English.
        return rows.map((r) => `${r.section_id}:${r.subject_id}`);
      },
    );
    return new Set(ids);
  }

  /** Invalidate a teacher's cached scope after an assignment change. */
  async invalidateTeacherScope(staffId: string | number): Promise<void> {
    await this.cache.delete('teacher-scope', `sections:${staffId}`);
    await this.cache.delete('teacher-scope', `subjects:${staffId}`);
  }
}

/**
 * Whether the caller may see or act on a particular student.
 *
 * The order of the branches is the order of least privilege: the broad
 * permission is checked first only because it is cheapest, then each narrower
 * relationship. Every path that does not establish a relationship falls through
 * to out-of-scope.
 */
export class StudentPolicy extends BasePolicy {
  async canView(ctx: PolicyContext, studentId: string): Promise<PolicyResult> {
    // Does the record exist at all? Checked first so a caller with broad rights
    // gets a genuine 404 rather than a scope answer.
    const exists = await ctx.uow.maybeOne<{ id: string }>(
      `SELECT id FROM students WHERE id = $1 AND deleted_at IS NULL`,
      [studentId],
    );
    if (!exists) return notFound();

    if (this.isAdmin(ctx) || this.holds(ctx, 'students.read_all')) return ALLOW;

    switch (ctx.actor.userType) {
      case 'guardian': {
        const children = await this.guardianChildIds(ctx);
        return children.has(studentId) ? ALLOW : outOfScope();
      }
      case 'student':
        return String(ctx.actor.studentId) === studentId ? ALLOW : outOfScope();
      case 'staff': {
        // A teacher sees the students of the sections they are assigned to.
        const sections = await this.teacherSectionIds(ctx);
        if (sections.size === 0) return outOfScope();
        const row = await ctx.uow.maybeOne<{ ok: boolean }>(
          `SELECT true AS ok
             FROM student_enrollments e
             JOIN academic_years ay ON ay.id = e.academic_year_id
            WHERE e.student_id = $1 AND ay.is_current
              AND e.section_id = ANY($2)
            LIMIT 1`,
          [studentId, [...sections]],
        );
        return row ? ALLOW : outOfScope();
      }
      default:
        return outOfScope();
    }
  }

  /** Editing is staff-only; a guardian may read their child but not change them. */
  async canEdit(ctx: PolicyContext, studentId: string): Promise<PolicyResult> {
    if (ctx.actor.userType === 'guardian' || ctx.actor.userType === 'student') {
      return outOfScope();
    }
    return this.canView(ctx, studentId);
  }
}

/** Whether the caller may act on a section — marking attendance, class lists. */
export class SectionPolicy extends BasePolicy {
  async canMarkAttendance(ctx: PolicyContext, sectionId: string): Promise<PolicyResult> {
    const exists = await ctx.uow.maybeOne<{ id: string }>(
      `SELECT id FROM sections WHERE id = $1 AND deleted_at IS NULL`,
      [sectionId],
    );
    if (!exists) return notFound();

    // The override permission is what lifts the assignment restriction; it is a
    // separate code precisely so holding "mark attendance" does not grant it.
    if (this.isAdmin(ctx) || this.holds(ctx, 'attendance.mark_override')) return ALLOW;

    if (ctx.actor.userType !== 'staff') return outOfScope();

    const sections = await this.teacherSectionIds(ctx);
    return sections.has(sectionId) ? ALLOW : outOfScope();
  }

  async canView(ctx: PolicyContext, sectionId: string): Promise<PolicyResult> {
    if (this.isAdmin(ctx) || this.holds(ctx, 'attendance.read_all') || this.holds(ctx, 'students.read_all')) {
      return ALLOW;
    }
    if (ctx.actor.userType !== 'staff') return outOfScope();
    const sections = await this.teacherSectionIds(ctx);
    return sections.has(sectionId) ? ALLOW : outOfScope();
  }
}

/** Staff records: your own, or anyone's with an HR permission. */
export class StaffPolicy extends BasePolicy {
  async canView(ctx: PolicyContext, staffId: string): Promise<PolicyResult> {
    const exists = await ctx.uow.maybeOne<{ id: string }>(
      `SELECT id FROM staff WHERE id = $1 AND deleted_at IS NULL`,
      [staffId],
    );
    if (!exists) return notFound();

    if (this.isAdmin(ctx) || this.holds(ctx, 'staff.read')) return ALLOW;
    return String(ctx.actor.staffId) === staffId ? ALLOW : outOfScope();
  }

  /**
   * Salary, national ID and bank details.
   *
   * Separate from `canView` because Part 7.2 and Module 7 both require it: a
   * staff member sees their own sensitive fields, and only an HR permission
   * holder sees anyone else's.
   */
  async canViewSensitive(ctx: PolicyContext, staffId: string): Promise<PolicyResult> {
    if (this.isAdmin(ctx) || this.holds(ctx, 'staff.read_sensitive')) return ALLOW;
    return String(ctx.actor.staffId) === staffId ? ALLOW : outOfScope();
  }
}

/** A user account: your own, or anyone's with a users permission. */
export class UserPolicy extends BasePolicy {
  async canView(ctx: PolicyContext, userId: string): Promise<PolicyResult> {
    if (this.isAdmin(ctx) || this.holds(ctx, 'users.read')) return ALLOW;
    return String(ctx.actor.userId) === userId ? ALLOW : outOfScope();
  }
}
