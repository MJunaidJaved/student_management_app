/**
 * Academic setup (Module 2).
 *
 * The rules worth stating, because each one prevents a specific mess:
 *
 *   * **Exactly one current year**, switched inside one transaction. Two current
 *     years makes "this year's enrollment" ambiguous everywhere; none makes it
 *     fail everywhere.
 *
 *   * **Closing is guarded by a pre-check.** A closed year is read-only,
 *     enforced by `guard_closed_year` on enrollments. Closing with unpaid
 *     invoices strands that money — it can no longer be collected against that
 *     year — so the blockers are reported and closure refused.
 *
 *   * **Capacity cannot drop below current enrollment.** Otherwise a section is
 *     immediately over capacity and every later capacity check fails against a
 *     number that was never achievable.
 *
 *   * **Soft delete refuses if referenced.** A deleted class with live
 *     enrollments leaves rows pointing at something the API pretends is gone.
 */

import { readTransaction, transaction, type Actor } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors';
import type { CacheStore } from '../../core/cache/cache';
import {
  AcademicYearRepository,
  ClassRepository,
  ClassSubjectRepository,
  RoomRepository,
  SectionRepository,
  SubjectRepository,
  SubjectTeacherRepository,
  TermRepository,
  assertYearOpen,
  type AcademicYearRow,
  type ClassRow,
  type RoomRow,
  type SectionWithStrength,
  type SubjectRow,
  type TermRow,
} from './academic.repository';

export type YearView = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  isClosed: boolean;
};

const toYearView = (r: AcademicYearRow): YearView => ({
  id: r.id,
  name: r.name,
  startDate: r.start_date,
  endDate: r.end_date,
  isCurrent: r.is_current,
  isClosed: r.is_closed,
});

export class AcademicService {
  constructor(
    private readonly years: AcademicYearRepository,
    private readonly terms: TermRepository,
    private readonly classes: ClassRepository,
    private readonly sections: SectionRepository,
    private readonly subjects: SubjectRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly subjectTeachers: SubjectTeacherRepository,
    private readonly rooms: RoomRepository,
    private readonly cache: CacheStore,
  ) {}

  /* ---------------- academic years ---------------- */

  async listYears(actor: Actor): Promise<YearView[]> {
    return readTransaction(actor, async (uow) =>
      (await this.years.listAll(uow)).map(toYearView),
    );
  }

  /**
   * The current year, cached.
   *
   * Almost every request needs it (Part 5.10), and it changes once a year.
   */
  async currentYear(actor: Actor): Promise<YearView> {
    const cached = await this.cache.getOrLoad('current-academic-year', 'current', async () =>
      readTransaction(actor, (uow) => this.years.findCurrent(uow)),
    );
    if (!cached) {
      throw new BusinessRuleError(
        'No academic year is marked as current. Set one before using the system.',
        'NO_CURRENT_YEAR',
      );
    }
    return toYearView(cached);
  }

  async createYear(
    actor: Actor,
    input: { name: string; startDate: string; endDate: string },
  ): Promise<YearView> {
    return transaction(actor, async (uow) => {
      if (input.endDate <= input.startDate) {
        throw new BusinessRuleError('The end date must be after the start date.', 'INVALID_RANGE');
      }

      // Overlapping years would make "which year is this date in" ambiguous for
      // fee periods and attendance.
      const overlapping = await this.years.findOverlapping(uow, input.startDate, input.endDate);
      if (overlapping.length) {
        throw new ConflictError(
          `Those dates overlap academic year "${overlapping[0]!.name}".`,
          'OVERLAPPING_YEAR',
        );
      }

      const row = await this.years.create(uow, {
        name: input.name,
        start_date: input.startDate,
        end_date: input.endDate,
      });
      return toYearView(row);
    });
  }

  async updateYear(
    actor: Actor,
    id: string,
    input: { name?: string | undefined; startDate?: string | undefined; endDate?: string | undefined },
  ): Promise<YearView> {
    return transaction(actor, async (uow) => {
      const existing = await this.years.getById(uow, id);
      if (existing.is_closed) {
        throw new BusinessRuleError(
          `Academic year "${existing.name}" is closed and cannot be edited.`,
          'YEAR_CLOSED',
        );
      }

      const startDate = input.startDate ?? existing.start_date;
      const endDate = input.endDate ?? existing.end_date;
      if (endDate <= startDate) {
        throw new BusinessRuleError('The end date must be after the start date.', 'INVALID_RANGE');
      }

      const overlapping = await this.years.findOverlapping(uow, startDate, endDate, id);
      if (overlapping.length) {
        throw new ConflictError(
          `Those dates overlap academic year "${overlapping[0]!.name}".`,
          'OVERLAPPING_YEAR',
        );
      }

      // Terms live inside the year, so narrowing it must not orphan them.
      const terms = await this.terms.listForYear(uow, id);
      const outside = terms.filter((t) => t.start_date < startDate || t.end_date > endDate);
      if (outside.length) {
        throw new BusinessRuleError(
          `Term "${outside[0]!.name}" would fall outside the new dates. Adjust the terms first.`,
          'TERM_OUTSIDE_YEAR',
        );
      }

      const row = await this.years.update(uow, id, {
        name: input.name,
        start_date: input.startDate,
        end_date: input.endDate,
      });
      await this.cache.clearNamespace('current-academic-year');
      return toYearView(row);
    });
  }

  async setCurrentYear(actor: Actor, id: string): Promise<YearView> {
    const view = await transaction(actor, async (uow) => {
      const year = await this.years.getById(uow, id);
      if (year.is_closed) {
        throw new BusinessRuleError(
          'A closed academic year cannot be made current.',
          'YEAR_CLOSED',
        );
      }
      return toYearView(await this.years.setCurrent(uow, id));
    });

    // Teacher scope is resolved against the current year, so it is stale now.
    await this.cache.clearNamespace('current-academic-year');
    await this.cache.clearNamespace('teacher-scope');
    return view;
  }

  /** What is blocking closure (Module 2's pre-check endpoint). */
  async closingPreCheck(
    actor: Actor,
    id: string,
  ): Promise<{ canClose: boolean; blockers: { reason: string; count: number }[] }> {
    return readTransaction(actor, async (uow) => {
      const year = await this.years.getById(uow, id);
      if (year.is_closed) {
        return { canClose: false, blockers: [{ reason: 'The year is already closed.', count: 0 }] };
      }

      const counts = await this.years.closingBlockers(uow, id);
      const blockers: { reason: string; count: number }[] = [];

      if (counts.unpaidInvoices > 0) {
        blockers.push({
          reason: 'Invoices are still unpaid or partly paid. Settle or carry them forward.',
          count: counts.unpaidInvoices,
        });
      }
      if (counts.unpublishedReportCards > 0) {
        blockers.push({
          reason: 'Report cards have not been published.',
          count: counts.unpublishedReportCards,
        });
      }
      if (counts.activeEnrollments > 0) {
        blockers.push({
          reason: 'Enrollments are still active. Run promotions to decide each one.',
          count: counts.activeEnrollments,
        });
      }
      if (counts.openExams > 0) {
        blockers.push({ reason: 'Exams are not yet locked.', count: counts.openExams });
      }

      return { canClose: blockers.length === 0, blockers };
    });
  }

  async closeYear(actor: Actor, id: string): Promise<YearView> {
    const check = await this.closingPreCheck(actor, id);
    if (!check.canClose) {
      throw new BusinessRuleError(
        `That year cannot be closed yet: ${check.blockers.map((b) => b.reason).join(' ')}`,
        'YEAR_NOT_CLOSEABLE',
      );
    }

    const view = await transaction(actor, async (uow) => {
      const year = await this.years.getById(uow, id);
      if (year.is_current) {
        // Closing the current year would leave the school with no writable
        // year at all.
        throw new BusinessRuleError(
          'The current academic year cannot be closed. Make another year current first.',
          'YEAR_IS_CURRENT',
        );
      }
      return toYearView(await this.years.close(uow, id));
    });

    await this.cache.clearNamespace('current-academic-year');
    return view;
  }

  /* ---------------- terms ---------------- */

  async listTerms(actor: Actor, yearId: string): Promise<TermRow[]> {
    return readTransaction(actor, (uow) => this.terms.listForYear(uow, yearId));
  }

  async createTerm(
    actor: Actor,
    input: { academicYearId: string; name: string; startDate: string; endDate: string },
  ): Promise<TermRow> {
    return transaction(actor, async (uow) => {
      await assertYearOpen(uow, input.academicYearId);
      const year = await this.years.getById(uow, input.academicYearId);

      if (input.endDate <= input.startDate) {
        throw new BusinessRuleError('The end date must be after the start date.', 'INVALID_RANGE');
      }
      if (input.startDate < year.start_date || input.endDate > year.end_date) {
        throw new BusinessRuleError(
          `A term must fall within ${year.name} (${year.start_date} to ${year.end_date}).`,
          'TERM_OUTSIDE_YEAR',
        );
      }

      const overlapping = await this.terms.findOverlapping(
        uow,
        input.academicYearId,
        input.startDate,
        input.endDate,
      );
      if (overlapping.length) {
        throw new ConflictError(
          `Those dates overlap term "${overlapping[0]!.name}".`,
          'OVERLAPPING_TERM',
        );
      }

      return this.terms.create(uow, {
        academic_year_id: input.academicYearId,
        name: input.name,
        start_date: input.startDate,
        end_date: input.endDate,
      });
    });
  }

  /* ---------------- classes ---------------- */

  async listClasses(actor: Actor): Promise<ClassRow[]> {
    return readTransaction(actor, (uow) => this.classes.listAll(uow));
  }

  async createClass(actor: Actor, input: { name: string; levelOrder: number }): Promise<ClassRow> {
    return transaction(actor, (uow) =>
      this.classes.create(uow, { name: input.name, level_order: input.levelOrder }),
    );
  }

  async updateClass(
    actor: Actor,
    id: string,
    input: { name?: string | undefined; levelOrder?: number | undefined },
  ): Promise<ClassRow> {
    return transaction(actor, (uow) =>
      this.classes.update(uow, id, { name: input.name, level_order: input.levelOrder }),
    );
  }

  async deleteClass(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.classes.referenceCounts(uow, id);
      if (counts.sections > 0 || counts.enrollments > 0) {
        throw new BusinessRuleError(
          `That class still has ${counts.sections} section(s) and ${counts.enrollments} enrollment(s). ` +
            'Remove or move them first.',
          'CLASS_IN_USE',
        );
      }
      await this.classes.softDelete(uow, id);
    });
  }

  /* ---------------- sections ---------------- */

  async listSections(actor: Actor, classId?: string): Promise<SectionWithStrength[]> {
    return readTransaction(actor, (uow) => this.sections.listWithStrength(uow, classId));
  }

  async createSection(
    actor: Actor,
    input: {
      classId: string;
      name: string;
      capacity: number;
      classTeacherId?: string | null | undefined;
    },
  ): Promise<SectionWithStrength> {
    return transaction(actor, async (uow) => {
      // Validated here for a friendly message; the FK is the real guard.
      await this.classes.getById(uow, input.classId);

      const row = await this.sections.create(uow, {
        class_id: input.classId,
        name: input.name,
        capacity: input.capacity,
        class_teacher_id: input.classTeacherId ?? null,
      });

      if (input.classTeacherId) await this.cache.clearNamespace('teacher-scope');

      const withStrength = await this.sections.listWithStrength(uow, input.classId);
      const found = withStrength.find((s) => s.id === row.id);
      if (!found) throw new NotFoundError('Section');
      return found;
    });
  }

  async updateSection(
    actor: Actor,
    id: string,
    input: {
      name?: string | undefined;
      capacity?: number | undefined;
      classTeacherId?: string | null | undefined;
    },
  ): Promise<SectionWithStrength> {
    const result = await transaction(actor, async (uow) => {
      const existing = await this.sections.getById(uow, id);

      if (input.capacity !== undefined) {
        const strength = await this.sections.currentStrength(uow, id);
        if (input.capacity < strength) {
          throw new BusinessRuleError(
            `Capacity cannot be less than the current enrollment of ${strength}.`,
            'CAPACITY_BELOW_STRENGTH',
          );
        }
      }

      await this.sections.update(uow, id, {
        name: input.name,
        capacity: input.capacity,
        // Distinguishes "not supplied" from "explicitly cleared".
        ...(input.classTeacherId !== undefined ? { class_teacher_id: input.classTeacherId } : {}),
      });

      const teacherChanged =
        input.classTeacherId !== undefined && input.classTeacherId !== existing.class_teacher_id;

      const list = await this.sections.listWithStrength(uow, existing.class_id);
      const found = list.find((s) => s.id === id);
      if (!found) throw new NotFoundError('Section');
      return { section: found, teacherChanged };
    });

    // A class teacher change alters that teacher's authorization scope.
    if (result.teacherChanged) await this.cache.clearNamespace('teacher-scope');
    return result.section;
  }

  /* ---------------- subjects ---------------- */

  async listSubjects(actor: Actor): Promise<SubjectRow[]> {
    return readTransaction(actor, (uow) => this.subjects.listAll(uow));
  }

  async createSubject(
    actor: Actor,
    input: { code: string; name: string; type: string },
  ): Promise<SubjectRow> {
    return transaction(actor, (uow) =>
      this.subjects.create(uow, { code: input.code, name: input.name, type: input.type }),
    );
  }

  async listClassSubjects(actor: Actor, classId: string) {
    return readTransaction(actor, (uow) => this.classSubjects.listForClass(uow, classId));
  }

  async setClassSubjects(
    actor: Actor,
    classId: string,
    entries: readonly { subjectId: string; isMandatory: boolean }[],
  ) {
    return transaction(actor, async (uow) => {
      await this.classes.getById(uow, classId);
      await this.classSubjects.setForClass(uow, classId, entries);
      return this.classSubjects.listForClass(uow, classId);
    });
  }

  /* ---------------- subject teachers ---------------- */

  async listSubjectTeachers(
    actor: Actor,
    yearId: string,
    filters: { sectionId?: string | undefined; staffId?: string | undefined } = {},
  ) {
    return readTransaction(actor, (uow) => this.subjectTeachers.listForYear(uow, yearId, filters));
  }

  /**
   * Assign a teacher to a subject in a section.
   *
   * Validates that the subject is actually taught by that section's class.
   * Without it a teacher can be assigned to teach chemistry to year 2, which
   * then appears in their authorization scope and on their timetable.
   */
  async assignSubjectTeacher(
    actor: Actor,
    input: { academicYearId: string; sectionId: string; subjectId: string; staffId: string },
  ) {
    const assignment = await transaction(actor, async (uow) => {
      await assertYearOpen(uow, input.academicYearId);

      const section = await this.sections.getById(uow, input.sectionId);
      if (!(await this.classSubjects.isMapped(uow, section.class_id, input.subjectId))) {
        throw new BusinessRuleError(
          'That subject is not part of this class’s curriculum. Map it to the class first.',
          'SUBJECT_NOT_IN_CLASS',
        );
      }

      return this.subjectTeachers.create(uow, {
        academic_year_id: input.academicYearId,
        section_id: input.sectionId,
        subject_id: input.subjectId,
        staff_id: input.staffId,
      });
    });

    await this.cache.clearNamespace('teacher-scope');
    return assignment;
  }

  async removeSubjectTeacher(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const row = await this.subjectTeachers.getById(uow, id);
      await assertYearOpen(uow, row.academic_year_id);
      await uow.count(`DELETE FROM subject_teachers WHERE id = $1`, [id]);
    });
    await this.cache.clearNamespace('teacher-scope');
  }

  /**
   * Copy setup from one year to another (Module 2).
   *
   * Only subject-teacher assignments are copied here. Fee structures are copied
   * by the fees module, which owns their validation, and class-subject mappings
   * are not year-scoped in this schema so they need no copying at all.
   */
  async copySetupFromYear(
    actor: Actor,
    fromYearId: string,
    toYearId: string,
  ): Promise<{ subjectTeachersCopied: number }> {
    const result = await transaction(actor, async (uow) => {
      if (fromYearId === toYearId) {
        throw new BusinessRuleError('Choose two different academic years.', 'SAME_YEAR');
      }
      await this.years.getById(uow, fromYearId);
      await assertYearOpen(uow, toYearId);

      return {
        subjectTeachersCopied: await this.subjectTeachers.copyToYear(uow, fromYearId, toYearId),
      };
    });

    await this.cache.clearNamespace('teacher-scope');
    return result;
  }

  /* ---------------- rooms ---------------- */

  async listRooms(actor: Actor): Promise<RoomRow[]> {
    return readTransaction(actor, (uow) => this.rooms.listAll(uow));
  }

  async createRoom(
    actor: Actor,
    input: { name: string; roomType: string; capacity?: number | null | undefined },
  ): Promise<RoomRow> {
    return transaction(actor, (uow) =>
      this.rooms.create(uow, {
        name: input.name,
        room_type: input.roomType,
        capacity: input.capacity ?? null,
      }),
    );
  }
}
