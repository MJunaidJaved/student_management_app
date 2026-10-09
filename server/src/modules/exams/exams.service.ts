/**
 * Exams, schedules, marks, grading and results (Module 6).
 *
 * The state machine is `EXAM_TRANSITIONS` (core/db/enums.ts): draft ->
 * published -> locked, with published -> draft a normal transition (reopen
 * for correction) and locked -> draft reachable only through `unlockExam`,
 * gated on the separate `exams.unlock` permission. `publishExam` serves both
 * "publish for the first time" and "re-publish after a correction" — the
 * database does not distinguish them, and nor does this service; each call
 * computes fresh and timestamps `published_at` again, so the business action
 * is the same either way.
 *
 * Nothing here ever trusts a client-sent total, percentage or grade — see
 * `computeResultsForEnrollment`, the only place those are produced.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import type { PermissionService } from '../../core/authz/permission-service';
import { Money } from '../../core/money/money';
import Decimal from 'decimal.js';
import { EXAM_TRANSITIONS, canTransition, type ExamStatus } from '../../core/db/enums';
import { assertYearOpen, type ClassSubjectRepository, type RoomRepository } from '../academic/academic.repository';
import {
  ExamTypeRepository,
  ExamRepository,
  ExamScheduleRepository,
  MarkRepository,
  GradingScaleRepository,
  GradingScaleRangeRepository,
  ReportCardRepository,
  type ExamTypeRow,
  type ExamRow,
  type ExamScheduleRow,
  type MarkRow,
  type GradingScaleRow,
  type GradingScaleRangeRow,
  type ReportCardRow,
} from './exams.repository';

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export type ExamTypeView = { id: string; name: string; weightage: string | null };
function toTypeView(r: ExamTypeRow): ExamTypeView {
  return { id: r.id, name: r.name, weightage: r.weightage };
}

export type ExamView = { id: string; academicYearId: string; termId: string | null; examTypeId: string; name: string; startDate: string; endDate: string; status: string };
function toExamView(r: ExamRow): ExamView {
  return { id: r.id, academicYearId: r.academic_year_id, termId: r.term_id, examTypeId: r.exam_type_id, name: r.name, startDate: r.start_date, endDate: r.end_date, status: r.status };
}

export type ExamScheduleView = {
  id: string; examId: string; classId: string; subjectId: string; examDate: string; startTime: string; endTime: string; roomId: string | null; totalMarks: string; passingMarks: string;
};
function toScheduleView(r: ExamScheduleRow): ExamScheduleView {
  return { id: r.id, examId: r.exam_id, classId: r.class_id, subjectId: r.subject_id, examDate: r.exam_date, startTime: r.start_time, endTime: r.end_time, roomId: r.room_id, totalMarks: r.total_marks, passingMarks: r.passing_marks };
}

export type MarkView = { id: string; examScheduleId: string; enrollmentId: string; marksObtained: string | null; isAbsent: boolean; isLocked: boolean };
function toMarkView(r: MarkRow): MarkView {
  return { id: r.id, examScheduleId: r.exam_schedule_id, enrollmentId: r.enrollment_id, marksObtained: r.marks_obtained, isAbsent: r.is_absent, isLocked: r.is_locked };
}

export type GradingScaleView = { id: string; name: string; isDefault: boolean };
function toScaleView(r: GradingScaleRow): GradingScaleView {
  return { id: r.id, name: r.name, isDefault: r.is_default };
}

export type GradingRangeView = { id: string; gradingScaleId: string; minPercent: string; maxPercent: string; grade: string; gpaPoints: string | null; remark: string | null };
function toRangeView(r: GradingScaleRangeRow): GradingRangeView {
  return { id: r.id, gradingScaleId: r.grading_scale_id, minPercent: r.min_percent, maxPercent: r.max_percent, grade: r.grade, gpaPoints: r.gpa_points, remark: r.remark };
}

export type ReportCardView = {
  id: string; examId: string; enrollmentId: string; totalMarks: string; obtainedMarks: string; percentage: string; grade: string | null; rank: number | null; remarks: string | null; publishedAt: string | null;
};
function toReportCardView(r: ReportCardRow): ReportCardView {
  return { id: r.id, examId: r.exam_id, enrollmentId: r.enrollment_id, totalMarks: r.total_marks, obtainedMarks: r.obtained_marks, percentage: r.percentage, grade: r.grade, rank: r.rank, remarks: r.remarks, publishedAt: r.published_at };
}

export class ExamsService {
  constructor(
    private readonly types: ExamTypeRepository,
    private readonly exams: ExamRepository,
    private readonly schedules: ExamScheduleRepository,
    private readonly marks: MarkRepository,
    private readonly scales: GradingScaleRepository,
    private readonly ranges: GradingScaleRangeRepository,
    private readonly reportCards: ReportCardRepository,
    private readonly classSubjects: ClassSubjectRepository,
    private readonly rooms: RoomRepository,
    private readonly permissions: PermissionService,
  ) {}

  private async heldPermissions(actor: Actor): Promise<ReadonlySet<string>> {
    return actor.userId === null ? new Set<string>() : this.permissions.forUser(actor.userId);
  }

  /* ---------------- exam types ---------------- */

  async listTypes(actor: Actor): Promise<ExamTypeView[]> {
    return readTransaction(actor, async (uow) => (await this.types.listAll(uow)).map(toTypeView));
  }

  async createType(actor: Actor, input: { name: string; weightage?: string | undefined }): Promise<ExamTypeView> {
    return transaction(actor, async (uow) => toTypeView(await this.types.create(uow, { name: input.name, weightage: input.weightage ?? null })));
  }

  async updateType(actor: Actor, id: string, input: { name?: string | undefined; weightage?: string | undefined }): Promise<ExamTypeView> {
    return transaction(actor, async (uow) => toTypeView(await this.types.update(uow, id, { name: input.name, weightage: input.weightage })));
  }

  async deleteType(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const inUse = await uow.maybeOne<{ ok: boolean }>(`SELECT true AS ok FROM exams WHERE exam_type_id = $1 LIMIT 1`, [id]);
      if (inUse) throw new BusinessRuleError('This exam type is used by at least one exam and cannot be removed.', 'EXAM_TYPE_IN_USE');
      await uow.count(`DELETE FROM exam_types WHERE id = $1`, [id]);
    });
  }

  /* ---------------- exams ---------------- */

  async listExams(actor: Actor, filters: { academicYearId?: string | undefined; termId?: string | undefined; status?: string | undefined }): Promise<ExamView[]> {
    return readTransaction(actor, async (uow) => (await this.exams.listFiltered(uow, filters)).map(toExamView));
  }

  async getExam(actor: Actor, id: string): Promise<ExamView> {
    return readTransaction(actor, async (uow) => toExamView(await this.exams.getById(uow, id)));
  }

  async createExam(actor: Actor, input: { academicYearId: string; termId?: string | undefined; examTypeId: string; name: string; startDate: string; endDate: string }): Promise<ExamView> {
    return transaction(actor, async (uow) => {
      await assertYearOpen(uow, input.academicYearId);
      if (input.termId) {
        const term = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM terms WHERE id = $1 AND academic_year_id = $2`, [input.termId, input.academicYearId]);
        if (!term) throw new ValidationError('That term does not belong to the selected academic year.', [{ field: 'termId', message: 'Does not belong to this academic year.' }]);
      }
      const row = await this.exams.create(uow, {
        academic_year_id: input.academicYearId, term_id: input.termId ?? null, exam_type_id: input.examTypeId,
        name: input.name, start_date: input.startDate, end_date: input.endDate, status: 'draft',
      });
      return toExamView(row);
    });
  }

  async updateExam(actor: Actor, id: string, input: { name?: string | undefined; startDate?: string | undefined; endDate?: string | undefined; termId?: string | undefined }): Promise<ExamView> {
    return transaction(actor, async (uow) => {
      const exam = await this.exams.getById(uow, id);
      if (exam.status !== 'draft') {
        throw new BusinessRuleError('Only a draft exam can be edited. Unlock it first if it is published or locked.', 'EXAM_NOT_DRAFT');
      }
      const row = await this.exams.update(uow, id, { name: input.name, start_date: input.startDate, end_date: input.endDate, term_id: input.termId });
      return toExamView(row);
    });
  }

  private async transition(uow: Uow, id: string, to: ExamStatus): Promise<ExamRow> {
    const exam = await this.exams.getById(uow, id);
    if (!canTransition(EXAM_TRANSITIONS, exam.status as ExamStatus, to)) {
      throw new BusinessRuleError(`An exam cannot go from "${exam.status}" to "${to}".`, 'ILLEGAL_EXAM_TRANSITION');
    }
    return exam;
  }

  /**
   * Publish (or re-publish after a correction): computes a report card for
   * every enrollment that has a complete set of marks for this exam's
   * schedules, then moves the exam to `published`. An enrollment missing a
   * mark for any of this exam's scheduled subjects is skipped, not failed —
   * one incomplete student does not block the rest of the class, and the
   * skip list says exactly who still needs marks entered.
   */
  async publishExam(actor: Actor, id: string): Promise<{ exam: ExamView; published: number; skipped: string[] }> {
    return transaction(actor, async (uow) => {
      await this.transition(uow, id, 'published');
      const { published, skipped } = await this.computeResultsForExam(uow, id, true);
      const row = await this.exams.setStatus(uow, id, 'published');
      return { exam: toExamView(row), published, skipped };
    });
  }

  /** Recompute without publishing — a preview, or a refresh of an already-published exam's figures. */
  async computeResults(actor: Actor, id: string): Promise<{ published: number; skipped: string[] }> {
    return transaction(actor, (uow) => this.computeResultsForExam(uow, id, false));
  }

  async lockExam(actor: Actor, id: string): Promise<ExamView> {
    return transaction(actor, async (uow) => {
      await this.transition(uow, id, 'locked');
      return toExamView(await this.exams.setStatus(uow, id, 'locked'));
    });
  }

  /** Bypasses the normal transition table on purpose — `locked` lists nothing reachable from it. Gated on `exams.unlock` at the route. */
  async unlockExam(actor: Actor, id: string): Promise<ExamView> {
    return transaction(actor, async (uow) => {
      const exam = await this.exams.getById(uow, id);
      if (exam.status !== 'locked') throw new BusinessRuleError('Only a locked exam can be unlocked.', 'EXAM_NOT_LOCKED');
      return toExamView(await this.exams.setStatus(uow, id, 'draft'));
    });
  }

  /* ---------------- exam schedules ---------------- */

  async listSchedules(actor: Actor, examId: string): Promise<ExamScheduleView[]> {
    return readTransaction(actor, async (uow) => (await this.schedules.listForExam(uow, examId)).map(toScheduleView));
  }

  async searchSchedules(actor: Actor, filters: { classId?: string | undefined; subjectId?: string | undefined; roomId?: string | undefined; examDate?: string | undefined; academicYearId?: string | undefined }): Promise<ExamScheduleView[]> {
    return readTransaction(actor, async (uow) => (await this.schedules.listFiltered(uow, filters)).map(toScheduleView));
  }

  async createSchedule(actor: Actor, input: { examId: string; classId: string; subjectId: string; examDate: string; startTime: string; endTime: string; roomId?: string | undefined; totalMarks: string; passingMarks: string }): Promise<ExamScheduleView> {
    return transaction(actor, async (uow) => {
      await this.validateScheduleReferences(uow, input);
      const conflicts = await this.schedules.findConflicts(uow, { examDate: input.examDate, startTime: input.startTime, endTime: input.endTime, roomId: input.roomId ?? null, classId: input.classId });
      if (conflicts.length) throw new BusinessRuleError(describeScheduleConflicts(conflicts), 'EXAM_SCHEDULE_CONFLICT');

      const row = await this.schedules.create(uow, {
        exam_id: input.examId, class_id: input.classId, subject_id: input.subjectId, exam_date: input.examDate,
        start_time: input.startTime, end_time: input.endTime, room_id: input.roomId ?? null,
        total_marks: input.totalMarks, passing_marks: input.passingMarks,
      });
      return toScheduleView(row);
    });
  }

  async updateSchedule(actor: Actor, id: string, input: { examDate?: string | undefined; startTime?: string | undefined; endTime?: string | undefined; roomId?: string | undefined; totalMarks?: string | undefined; passingMarks?: string | undefined }): Promise<ExamScheduleView> {
    return transaction(actor, async (uow) => {
      const existing = await this.schedules.getById(uow, id);
      const exam = await this.exams.getById(uow, existing.exam_id);
      if (exam.status !== 'draft') throw new BusinessRuleError('Schedules can only be changed while the exam is a draft.', 'EXAM_NOT_DRAFT');

      const merged = {
        examDate: input.examDate ?? existing.exam_date,
        startTime: input.startTime ?? existing.start_time,
        endTime: input.endTime ?? existing.end_time,
        roomId: input.roomId !== undefined ? input.roomId : existing.room_id,
        classId: existing.class_id,
      };
      if (merged.endTime <= merged.startTime) throw new ValidationError('End time must be after start time.', [{ field: 'endTime', message: 'Must be after start time.' }]);
      const conflicts = await this.schedules.findConflicts(uow, merged, id);
      if (conflicts.length) throw new BusinessRuleError(describeScheduleConflicts(conflicts), 'EXAM_SCHEDULE_CONFLICT');

      const row = await this.schedules.update(uow, id, {
        exam_date: input.examDate, start_time: input.startTime, end_time: input.endTime,
        room_id: input.roomId, total_marks: input.totalMarks, passing_marks: input.passingMarks,
      });
      return toScheduleView(row);
    });
  }

  /** Cancelling is a hard delete — there is no status column on this table — blocked while marks exist, so a correction is never a silent data loss. */
  async cancelSchedule(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const existing = await this.schedules.getById(uow, id);
      const exam = await this.exams.getById(uow, existing.exam_id);
      if (exam.status !== 'draft') throw new BusinessRuleError('Schedules can only be cancelled while the exam is a draft.', 'EXAM_NOT_DRAFT');
      const markCount = await uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM marks WHERE exam_schedule_id = $1`, [id]);
      if (markCount.n > 0) throw new BusinessRuleError(`This schedule already has ${markCount.n} mark(s) entered. Remove them first.`, 'EXAM_SCHEDULE_HAS_MARKS');
      await uow.count(`DELETE FROM exam_schedules WHERE id = $1`, [id]);
    });
  }

  private async validateScheduleReferences(uow: Uow, input: { examId: string; classId: string; subjectId: string; endTime: string; startTime: string; roomId?: string | undefined }): Promise<void> {
    const exam = await this.exams.getById(uow, input.examId);
    if (exam.status !== 'draft') throw new BusinessRuleError('Schedules can only be added while the exam is a draft.', 'EXAM_NOT_DRAFT');
    if (input.endTime <= input.startTime) throw new ValidationError('End time must be after start time.', [{ field: 'endTime', message: 'Must be after start time.' }]);

    const mapped = await this.classSubjects.isMapped(uow, input.classId, input.subjectId);
    if (!mapped) throw new BusinessRuleError('That subject is not part of this class’s curriculum.', 'SUBJECT_NOT_IN_CLASS');
    if (input.roomId) await this.rooms.getById(uow, input.roomId);
  }

  /* ---------------- marks ---------------- */

  /**
   * A teacher may enter marks only for a schedule whose subject they teach
   * somewhere in that class (any section) in the exam's academic year — the
   * same `subject_teachers` check Section 2's timetable uses, generalised
   * from one section to "any section of this class" because an exam
   * schedule is per-class, not per-section.
   */
  private async assertCanEnterMarks(uow: Uow, actor: Actor, schedule: ExamScheduleRow, examYearId: string): Promise<void> {
    const held = await this.heldPermissions(actor);
    if (actor.userType === 'admin' || held.has('exams.enter_marks_override')) return;
    if (!held.has('exams.enter_marks')) throw new ForbiddenError('You do not have permission to enter marks.');
    if (actor.userType !== 'staff') throw new ForbiddenError('You do not have permission to enter marks.');

    const assigned = await uow.maybeOne<{ ok: boolean }>(
      `SELECT true AS ok FROM subject_teachers st JOIN sections s ON s.id = st.section_id
        WHERE st.academic_year_id = $1 AND s.class_id = $2 AND st.subject_id = $3 AND st.staff_id = $4`,
      [examYearId, schedule.class_id, schedule.subject_id, actor.staffId],
    );
    if (!assigned) throw new ForbiddenError('You are not assigned to teach this subject for this class.');
  }

  /** Viewing is allowed to anyone who could enter marks here, plus a plain `exams.read` holder — reading is never narrower than writing. */
  private async assertCanViewSchedule(uow: Uow, actor: Actor, schedule: ExamScheduleRow, examYearId: string): Promise<void> {
    const held = await this.heldPermissions(actor);
    if (actor.userType === 'admin' || held.has('exams.read_all') || held.has('exams.read')) return;
    await this.assertCanEnterMarks(uow, actor, schedule, examYearId);
  }

  async getMarksForSchedule(actor: Actor, examScheduleId: string): Promise<(MarkView & { firstName: string; lastName: string | null; rollNo: number })[]> {
    return readTransaction(actor, async (uow) => {
      const schedule = await this.schedules.getById(uow, examScheduleId);
      const exam = await this.exams.getById(uow, schedule.exam_id);
      await this.assertCanViewSchedule(uow, actor, schedule, exam.academic_year_id);
      const rows = await this.marks.forSchedule(uow, examScheduleId);
      return rows.map((r) => ({ ...toMarkView(r), firstName: r.first_name, lastName: r.last_name, rollNo: r.roll_no }));
    });
  }

  /**
   * Bulk marks entry for one exam schedule (Part 9.3: one statement, not a
   * loop). Every enrollment must actually belong to the schedule's class and
   * academic year and be active — never trust an id the client sent — and
   * every mark must respect `is_absent`'s own shape: an absent student
   * carries no numeric mark, a present one does.
   */
  async submitMarks(
    actor: Actor,
    input: { examScheduleId: string; entries: { enrollmentId: string; marksObtained?: string | undefined; isAbsent: boolean }[] },
  ): Promise<MarkView[]> {
    return transaction(actor, async (uow) => {
      if (input.entries.length === 0) throw new ValidationError('At least one entry is required.', [{ field: 'entries', message: 'Must not be empty.' }]);

      const schedule = await this.schedules.getById(uow, input.examScheduleId);
      const exam = await this.exams.getById(uow, schedule.exam_id);
      await this.assertCanEnterMarks(uow, actor, schedule, exam.academic_year_id);

      for (const e of input.entries) {
        if (e.isAbsent && e.marksObtained !== undefined) {
          throw new ValidationError('An absent entry must not carry a mark.', [{ field: 'entries', message: 'isAbsent and marksObtained are mutually exclusive.' }]);
        }
        if (!e.isAbsent && e.marksObtained === undefined) {
          throw new ValidationError('A present entry needs a mark.', [{ field: 'entries', message: 'marksObtained is required unless isAbsent.' }]);
        }
      }

      const valid = await uow.many<{ id: string }>(
        `SELECT id::text AS id FROM student_enrollments
          WHERE class_id = $1 AND academic_year_id = $2 AND status = 'active' AND id = ANY($3)`,
        [schedule.class_id, exam.academic_year_id, input.entries.map((e) => e.enrollmentId)],
      );
      const validIds = new Set(valid.map((v) => v.id));
      const bad = input.entries.filter((e) => !validIds.has(e.enrollmentId));
      if (bad.length > 0) {
        throw new BusinessRuleError(
          `${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} reference an enrollment outside this class, year, or no longer active: ${bad.map((b) => b.enrollmentId).join(', ')}`,
          'INVALID_ENROLLMENT_IN_BATCH',
        );
      }

      const rows = await this.marks.bulkUpsert(
        uow,
        input.entries.map((e) => ({
          exam_schedule_id: input.examScheduleId,
          enrollment_id: e.enrollmentId,
          marks_obtained: e.isAbsent ? null : Money.of(e.marksObtained!).quantize().toString(),
          is_absent: e.isAbsent,
          entered_by: String(actor.userId),
        })),
      );
      return rows.map(toMarkView);
    });
  }

  async setMarkLock(actor: Actor, id: string, locked: boolean): Promise<MarkView> {
    return transaction(actor, async (uow) => toMarkView(await this.marks.setLocked(uow, id, locked)));
  }

  /* ---------------- grading scales ---------------- */

  async listScales(actor: Actor): Promise<GradingScaleView[]> {
    return readTransaction(actor, async (uow) => (await this.scales.listAll(uow)).map(toScaleView));
  }

  async createScale(actor: Actor, input: { name: string; isDefault?: boolean | undefined }): Promise<GradingScaleView> {
    return transaction(actor, async (uow) => {
      if (input.isDefault) await this.scales.clearDefault(uow);
      return toScaleView(await this.scales.create(uow, { name: input.name, is_default: input.isDefault ?? false }));
    });
  }

  async setDefaultScale(actor: Actor, id: string): Promise<GradingScaleView> {
    return transaction(actor, async (uow) => {
      await this.scales.getById(uow, id);
      await this.scales.clearDefault(uow);
      return toScaleView(await this.scales.update(uow, id, { is_default: true }));
    });
  }

  async listRanges(actor: Actor, scaleId: string): Promise<GradingRangeView[]> {
    return readTransaction(actor, async (uow) => (await this.ranges.listForScale(uow, scaleId)).map(toRangeView));
  }

  async createRange(actor: Actor, input: { gradingScaleId: string; minPercent: string; maxPercent: string; grade: string; gpaPoints?: string | undefined; remark?: string | undefined }): Promise<GradingRangeView> {
    return transaction(actor, async (uow) => {
      if (Number(input.minPercent) > Number(input.maxPercent)) {
        throw new ValidationError('The minimum percentage must not exceed the maximum.', [{ field: 'minPercent', message: 'Must be <= maxPercent.' }]);
      }
      const row = await this.ranges.create(uow, {
        grading_scale_id: input.gradingScaleId, min_percent: input.minPercent, max_percent: input.maxPercent,
        grade: input.grade, gpa_points: input.gpaPoints ?? null, remark: input.remark ?? null,
      });
      return toRangeView(row);
    });
  }

  async updateRange(actor: Actor, id: string, input: { minPercent?: string | undefined; maxPercent?: string | undefined; grade?: string | undefined; gpaPoints?: string | undefined; remark?: string | undefined }): Promise<GradingRangeView> {
    return transaction(actor, async (uow) => toRangeView(await this.ranges.update(uow, id, {
      min_percent: input.minPercent, max_percent: input.maxPercent, grade: input.grade, gpa_points: input.gpaPoints, remark: input.remark,
    })));
  }

  async deleteRange(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      await this.ranges.getById(uow, id);
      await uow.count(`DELETE FROM grading_scale_ranges WHERE id = $1`, [id]);
    });
  }

  /* ---------------- results and report cards ---------------- */

  /**
   * No `exams.read_own` exists in the catalogue — student/guardian portal
   * access was left conditional ("if portal access exists") rather than
   * pre-allocated a code of its own. This grants it structurally instead: a
   * guardian or student may see a *published* report card for their own
   * linked child or themselves, the same ownership shape `fees.read_own`
   * uses, without a dedicated permission gate.
   */
  private async assertCanViewOwnEnrollment(uow: Uow, actor: Actor, enrollmentId: string): Promise<void> {
    if (actor.userType === 'guardian') {
      const linked = await uow.maybeOne<{ ok: boolean }>(
        `SELECT true AS ok FROM student_enrollments e JOIN student_guardians sg ON sg.student_id = e.student_id
          WHERE e.id = $1 AND sg.guardian_id = $2`,
        [enrollmentId, actor.guardianId],
      );
      if (linked) return;
    } else if (actor.userType === 'student') {
      const own = await uow.maybeOne<{ ok: boolean }>(`SELECT true AS ok FROM student_enrollments WHERE id = $1 AND student_id = $2`, [enrollmentId, actor.studentId]);
      if (own) return;
    }
    throw new NotFoundError('Report card');
  }

  /** A teacher's broader `exams.read` is scoped to classes they are assigned to teach, the same way `attendance.read` scopes to a teacher's own sections. */
  private async assertCanViewClass(uow: Uow, actor: Actor, classId: string, academicYearId: string): Promise<void> {
    const held = await this.heldPermissions(actor);
    if (actor.userType === 'admin' || held.has('exams.read_all')) return;
    if (held.has('exams.read') && actor.userType === 'staff') {
      const assigned = await uow.maybeOne<{ ok: boolean }>(
        `SELECT true AS ok FROM subject_teachers st JOIN sections s ON s.id = st.section_id
          WHERE st.academic_year_id = $1 AND s.class_id = $2 AND st.staff_id = $3
         UNION
         SELECT true FROM sections WHERE class_id = $2 AND class_teacher_id = $3 AND deleted_at IS NULL`,
        [academicYearId, classId, actor.staffId],
      );
      if (assigned) return;
    }
    throw new ForbiddenError('You do not have permission to view results for this class.');
  }

  async getReportCard(actor: Actor, examId: string, enrollmentId: string): Promise<ReportCardView> {
    return readTransaction(actor, async (uow) => {
      const row = await this.reportCards.findForExamAndEnrollment(uow, examId, enrollmentId);
      if (!row) throw new NotFoundError('Report card');
      const held = await this.heldPermissions(actor);
      if (actor.userType !== 'admin' && !held.has('exams.read_all') && !held.has('exams.read')) {
        if (!row.published_at) throw new NotFoundError('Report card');
        await this.assertCanViewOwnEnrollment(uow, actor, enrollmentId);
      }
      return toReportCardView(row);
    });
  }

  async listReportCardsForExam(actor: Actor, examId: string, classId: string): Promise<(ReportCardView & { firstName: string; lastName: string | null; rollNo: number; classId: string; sectionId: string })[]> {
    return readTransaction(actor, async (uow) => {
      const exam = await this.exams.getById(uow, examId);
      await this.assertCanViewClass(uow, actor, classId, exam.academic_year_id);
      const rows = await this.reportCards.listForExam(uow, examId);
      return rows.filter((r) => r.class_id === classId).map((r) => ({ ...toReportCardView(r), firstName: r.first_name, lastName: r.last_name, rollNo: r.roll_no, classId: r.class_id, sectionId: r.section_id }));
    });
  }

  async listReportCardsForEnrollment(actor: Actor, enrollmentId: string): Promise<(ReportCardView & { examName: string })[]> {
    return readTransaction(actor, async (uow) => {
      const held = await this.heldPermissions(actor);
      const broad = actor.userType === 'admin' || held.has('exams.read_all') || held.has('exams.read');
      if (!broad) await this.assertCanViewOwnEnrollment(uow, actor, enrollmentId);
      const rows = await this.reportCards.listForEnrollment(uow, enrollmentId);
      const visible = broad ? rows : rows.filter((r) => r.published_at !== null);
      return visible.map((r) => ({ ...toReportCardView(r), examName: r.exam_name }));
    });
  }

  /**
   * The actual computation, shared by `publishExam` and `computeResults`.
   * `touchPublishedAt` is what distinguishes "publish" from "preview" — a
   * preview never sets a timestamp a student or guardian could read as
   * official.
   */
  private async computeResultsForExam(uow: Uow, examId: string, touchPublishedAt: boolean): Promise<{ published: number; skipped: string[] }> {
    const exam = await this.exams.getById(uow, examId);
    const schedules = await this.schedules.listForExam(uow, examId);
    if (schedules.length === 0) throw new BusinessRuleError('This exam has no schedules; nothing to compute.', 'EXAM_HAS_NO_SCHEDULES');

    const scheduleIdsByClass = new Map<string, string[]>();
    for (const s of schedules) {
      scheduleIdsByClass.set(s.class_id, [...(scheduleIdsByClass.get(s.class_id) ?? []), s.id]);
    }

    // Every active enrollment in a class this exam schedules for, not only
    // those with at least one mark already — a student with zero marks
    // entered must appear in `skipped`, not vanish from the result silently.
    const enrollmentRows = await uow.many<{ id: string; class_id: string; section_id: string }>(
      `SELECT e.id::text AS id, e.class_id::text AS class_id, e.section_id::text AS section_id
         FROM student_enrollments e
        WHERE e.class_id = ANY($1) AND e.academic_year_id = $2 AND e.status = 'active'`,
      [[...scheduleIdsByClass.keys()], exam.academic_year_id],
    );

    const results: { enrollmentId: string; classId: string; sectionId: string; obtained: Decimal; total: Decimal; percentage: Decimal }[] = [];
    const skipped: string[] = [];

    for (const enrollment of enrollmentRows) {
      const requiredScheduleIds = scheduleIdsByClass.get(enrollment.class_id) ?? [];
      const studentMarks = await this.marks.forEnrollmentAndExam(uow, enrollment.id, examId);
      const bySchedule = new Map(studentMarks.map((m) => [m.exam_schedule_id, m]));

      if (requiredScheduleIds.some((id) => !bySchedule.has(id))) {
        skipped.push(enrollment.id);
        continue;
      }

      let obtained = new Decimal(0);
      let total = new Decimal(0);
      for (const scheduleId of requiredScheduleIds) {
        const mark = bySchedule.get(scheduleId)!;
        total = total.plus(mark.total_marks);
        if (!mark.is_absent && mark.marks_obtained !== null) obtained = obtained.plus(mark.marks_obtained);
      }
      const percentage = total.isZero() ? new Decimal(0) : obtained.dividedBy(total).times(100).toDecimalPlaces(2);
      results.push({ enrollmentId: enrollment.id, classId: enrollment.class_id, sectionId: enrollment.section_id, obtained, total, percentage });
    }

    // Standard competition ranking, computed per class (the unit a report
    // card is compared within): equal percentages share a rank, and the next
    // distinct percentage's rank is its 1-based position, ties included.
    const rankByClass = new Map<string, number>();
    const sortedByClass = new Map<string, typeof results>();
    for (const r of results) sortedByClass.set(r.classId, [...(sortedByClass.get(r.classId) ?? []), r]);

    const defaultScale = await this.scales.findDefault(uow);

    for (const [classId, classResults] of sortedByClass) {
      classResults.sort((a, b) => b.percentage.comparedTo(a.percentage));
      let previousPercentage: Decimal | null = null;
      let rank = 0;
      let seen = 0;
      for (const r of classResults) {
        seen += 1;
        if (previousPercentage === null || !r.percentage.equals(previousPercentage)) rank = seen;
        previousPercentage = r.percentage;
        rankByClass.set(`${classId}:${r.enrollmentId}`, rank);
      }
    }

    for (const r of results) {
      const grade = defaultScale ? (await this.ranges.findForPercentage(uow, defaultScale.id, r.percentage.toString()))?.grade ?? null : null;
      // A preview (touchPublishedAt false) must never erase an existing
      // publish timestamp — recomputing an already-published exam's figures
      // is a correction to the numbers, not an unpublish.
      const existing = touchPublishedAt ? null : await this.reportCards.findForExamAndEnrollment(uow, examId, r.enrollmentId);
      await this.reportCards.upsert(uow, {
        exam_id: examId,
        enrollment_id: r.enrollmentId,
        total_marks: r.total.toDecimalPlaces(2).toString(),
        obtained_marks: r.obtained.toDecimalPlaces(2).toString(),
        percentage: r.percentage.toString(),
        grade,
        rank: rankByClass.get(`${r.classId}:${r.enrollmentId}`) ?? null,
        published_at: touchPublishedAt ? new Date().toISOString() : (existing?.published_at ?? null),
      });
    }

    return { published: results.length, skipped };
  }
}

function describeScheduleConflicts(conflicts: readonly { dimension: 'room' | 'class'; subjectName: string }[]): string {
  return conflicts
    .map((c) => (c.dimension === 'room' ? `That room is already booked for ${c.subjectName} at that time.` : `This class already has ${c.subjectName} scheduled at that time.`))
    .join(' ');
}
