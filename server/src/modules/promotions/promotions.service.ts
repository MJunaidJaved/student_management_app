/**
 * Student promotion (Module 3's end-of-year workflow).
 *
 * A preview lists who is eligible and proposes "promoted" for each —
 * applying is always a separate, explicit, authorized action, never
 * automatic. There is no pass/fail rule wired in from exam results: nothing
 * in the existing schema or brief ties a grading outcome to a promotion
 * decision, so inventing one here would be exactly the kind of business
 * rule Part 0 says not to add unasked. The decision (promoted, detained or
 * graduated) is the caller's, per enrollment, at apply time.
 *
 * Applying a batch is one transaction, not one per row (Section 3's bulk
 * invoice generation deliberately isolates each row so one failure doesn't
 * block the rest — promotion is the opposite: a partially-applied batch
 * would leave some students in next year's class and others still in this
 * year's, which is the exact inconsistency the brief asks to avoid).
 */

import { transaction, readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, ValidationError } from '../../core/errors';
import { assertYearOpen, type SectionRepository } from '../academic/academic.repository';
import type { EnrollmentRepository, StudentRepository } from '../students/students.repository';
import { StudentPromotionRepository, type StudentPromotionRow } from './promotions.repository';

export type PromotionCandidateView = {
  enrollmentId: string;
  studentId: string;
  sectionId: string;
  rollNo: number;
  firstName: string;
  lastName: string | null;
  admissionNo: string;
  proposedAction: 'promoted';
};

export type PromotionDecisionView = {
  id: string;
  fromEnrollmentId: string;
  toEnrollmentId: string | null;
  action: string;
  decidedBy: string | null;
  decidedOn: string;
  remarks: string | null;
};

function toDecisionView(r: StudentPromotionRow): PromotionDecisionView {
  return { id: r.id, fromEnrollmentId: r.from_enrollment_id, toEnrollmentId: r.to_enrollment_id, action: r.action, decidedBy: r.decided_by, decidedOn: r.decided_on, remarks: r.remarks };
}

export type PromotionAction = 'promoted' | 'detained' | 'graduated';

export class PromotionsService {
  constructor(
    private readonly promotions: StudentPromotionRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly students: StudentRepository,
    private readonly sections: SectionRepository,
  ) {}

  async preview(actor: Actor, filters: { academicYearId: string; classId: string; sectionId?: string | undefined }): Promise<PromotionCandidateView[]> {
    return readTransaction(actor, async (uow) => {
      const rows = await this.promotions.enrollmentsEligibleForPromotion(uow, filters);
      return rows.map((r) => ({
        enrollmentId: r.id, studentId: r.student_id, sectionId: r.section_id, rollNo: r.roll_no,
        firstName: r.first_name, lastName: r.last_name, admissionNo: r.admission_no, proposedAction: 'promoted' as const,
      }));
    });
  }

  async history(actor: Actor, studentId: string): Promise<PromotionDecisionView[]> {
    return readTransaction(actor, async (uow) => (await this.promotions.listForStudent(uow, studentId)).map(toDecisionView));
  }

  /**
   * Apply a batch of promotion decisions in one transaction. Each decision
   * closes its source enrollment (status becomes the decided action — DB
   * `ENROLLMENT_STATUSES` has no "graduated" value, so a graduated decision
   * closes the enrollment as "promoted" — out of the school, not held back
   * — and marks the student record itself graduated, which is where that
   * status belongs) and, unless graduating, opens a new enrollment in the
   * target year/class/section with the normal capacity and roll-number
   * rules every other enrollment path already follows.
   */
  async apply(
    actor: Actor,
    input: {
      toAcademicYearId: string;
      decisions: { fromEnrollmentId: string; action: PromotionAction; toClassId?: string | undefined; toSectionId?: string | undefined; remarks?: string | undefined }[];
    },
  ): Promise<{ applied: number; decisions: PromotionDecisionView[] }> {
    return transaction(actor, async (uow) => {
      if (input.decisions.length === 0) throw new ValidationError('At least one decision is required.', [{ field: 'decisions', message: 'Must not be empty.' }]);
      await assertYearOpen(uow, input.toAcademicYearId);

      const decisions: PromotionDecisionView[] = [];
      for (const d of input.decisions) {
        decisions.push(await this.applyOne(uow, actor, input.toAcademicYearId, d));
      }
      return { applied: decisions.length, decisions };
    });
  }

  private async applyOne(
    uow: Uow,
    actor: Actor,
    toAcademicYearId: string,
    d: { fromEnrollmentId: string; action: PromotionAction; toClassId?: string | undefined; toSectionId?: string | undefined; remarks?: string | undefined },
  ): Promise<PromotionDecisionView> {
    const fromEnrollment = await this.enrollments.getById(uow, d.fromEnrollmentId);
    // Checked before the active-status guard: an already-decided enrollment
    // is also no longer active (its status was set to the earlier decision's
    // action), and "you already decided this" is the more useful of the two
    // true statements.
    const existing = await this.promotions.findForEnrollment(uow, d.fromEnrollmentId);
    if (existing) throw new ConflictError(`Enrollment ${d.fromEnrollmentId} has already been decided.`, 'ALREADY_PROMOTED');
    if (fromEnrollment.status !== 'active') {
      throw new BusinessRuleError(`Enrollment ${d.fromEnrollmentId} is not active and cannot be promoted.`, 'ENROLLMENT_NOT_ACTIVE');
    }

    let toEnrollmentId: string | null = null;

    if (d.action === 'graduated') {
      if (d.toClassId || d.toSectionId) {
        throw new ValidationError('A graduated decision must not specify a target class or section.', [{ field: 'toClassId', message: 'Must be omitted when action is graduated.' }]);
      }
      await this.enrollments.setStatus(uow, d.fromEnrollmentId, 'promoted');
      await this.students.setStatus(uow, fromEnrollment.student_id, 'graduated');
    } else {
      if (!d.toClassId || !d.toSectionId) {
        throw new ValidationError('A target class and section are required unless the action is graduated.', [{ field: 'toClassId', message: 'Required.' }]);
      }
      const section = await this.sections.lockForEnrollment(uow, d.toSectionId);
      if (section.class_id !== d.toClassId) {
        throw new ValidationError('That section does not belong to the target class.', [{ field: 'toSectionId', message: 'Must belong to toClassId.' }]);
      }
      const strength = await this.sections.strengthForYear(uow, d.toSectionId, toAcademicYearId);
      if (strength >= section.capacity) {
        throw new BusinessRuleError(`Target section is full (${strength} of ${section.capacity}).`, 'SECTION_FULL');
      }
      const rollNo = await this.enrollments.nextRollNo(uow, d.toSectionId, toAcademicYearId);
      const newEnrollment = await this.enrollments.create(uow, {
        student_id: fromEnrollment.student_id,
        academic_year_id: toAcademicYearId,
        class_id: d.toClassId,
        section_id: d.toSectionId,
        roll_no: rollNo,
        enrolled_on: new Date().toISOString().slice(0, 10),
      });
      toEnrollmentId = newEnrollment.id;
      await this.enrollments.setStatus(uow, d.fromEnrollmentId, d.action);
    }

    const row = await this.promotions.create(uow, {
      from_enrollment_id: d.fromEnrollmentId,
      to_enrollment_id: toEnrollmentId,
      action: d.action,
      decided_by: actor.userId,
      decided_on: new Date().toISOString().slice(0, 10),
      remarks: d.remarks ?? null,
    });
    return toDecisionView(row);
  }
}
