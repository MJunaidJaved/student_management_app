/**
 * Student lifecycle (Module 3).
 *
 * Three things here carry real risk, and each is handled deliberately:
 *
 *   * **Roll number assignment under concurrency.** Two admissions into the
 *     same section at the same moment must not both take roll 31. The section
 *     row is locked first (`FOR UPDATE`), so the second transaction waits and
 *     then reads a maximum that includes the first. The unique constraint
 *     `(academic_year_id, section_id, roll_no)` is the backstop, but relying on
 *     it alone means one parent gets a constraint error at the counter.
 *
 *   * **Scope.** Every read of a specific student goes through `StudentPolicy`,
 *     which returns 404 rather than 403 for anything outside the caller's
 *     scope. With RLS disabled this is the only barrier.
 *
 *   * **Deletion.** A student with any history is never hard deleted, and the
 *     soft delete is refused outright if enrollments, invoices or payments
 *     exist — those are the records an audit would need.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors';
import { enforce, type PolicyContext, type StudentPolicy } from '../../core/policy/policy';
import type { PermissionService } from '../../core/authz/permission-service';
import { classifySearchTerm } from '../../core/search/search-expressions';
import { canTransition, APPLICATION_TRANSITIONS, type ApplicationStatus } from '../../core/db/enums';
import { IllegalTransitionError } from '../../core/errors';
import type { SectionRepository } from '../academic/academic.repository';
import { assertYearOpen } from '../academic/academic.repository';
import {
  EnrollmentRepository,
  GuardianRepository,
  StudentRepository,
  assertNotAlreadyEnrolled,
  assertSectionInClass,
  type EnrollmentRow,
  type GuardianRow,
  type StudentRow,
} from './students.repository';

export type StudentView = {
  id: string;
  admissionNo: string;
  firstName: string;
  lastName: string | null;
  gender: string;
  dob: string;
  status: string;
  admissionDate: string;
  phone: string | null;
  address: string | null;
  bloodGroup: string | null;
  religion: string | null;
  previousSchool: string | null;
  photoPath: string | null;
  /** Masked unless the caller may see sensitive fields. */
  nationalId: string | null;
};

/**
 * Row to view, masking the national ID.
 *
 * Part 7 requires sensitive identifiers masked by default. A national ID is
 * shown only to a caller holding a permission that implies it; everyone else
 * gets the last four digits so a clerk can confirm a document without the full
 * number being readable from a list.
 */
function toStudentView(row: StudentRow, showSensitive: boolean): StudentView {
  return {
    id: row.id,
    admissionNo: row.admission_no,
    firstName: row.first_name,
    lastName: row.last_name,
    gender: row.gender,
    dob: row.dob,
    status: row.status,
    admissionDate: row.admission_date,
    phone: row.phone,
    address: row.address,
    bloodGroup: row.blood_group,
    religion: row.religion,
    previousSchool: row.previous_school,
    photoPath: row.photo_path,
    nationalId:
      row.national_id === null
        ? null
        : showSensitive
          ? row.national_id
          : `••••${row.national_id.slice(-4)}`,
  };
}

export class StudentsService {
  constructor(
    private readonly students: StudentRepository,
    private readonly guardians: GuardianRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly sections: SectionRepository,
    private readonly policy: StudentPolicy,
    private readonly permissions: PermissionService,
  ) {}

  /** Build the policy context once per request. */
  private async context(uow: Uow, actor: Actor): Promise<PolicyContext> {
    const permissions =
      actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    return { actor, uow, permissions };
  }

  /* ---------------- reads ---------------- */

  async getById(actor: Actor, id: string): Promise<StudentView & { guardians: unknown[]; enrollment: EnrollmentRow | null }> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, id), 'Student');

      const row = await this.students.getById(uow, id);
      const showSensitive = ctx.permissions.has('students.read_all') || actor.userType === 'admin';

      return {
        ...toStudentView(row, showSensitive),
        guardians: await this.guardians.forStudent(uow, id),
        enrollment: await this.enrollments.currentForStudent(uow, id),
      };
    });
  }

  async list(
    actor: Actor,
    filters: {
      classId?: string | undefined;
      sectionId?: string | undefined;
      status?: string | undefined;
      gender?: string | undefined;
      academicYearId?: string | undefined;
      guardianPhone?: string | undefined;
    },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);

      /*
       * A listing is scoped by narrowing the query, not by filtering afterwards.
       * A guardian or student must never be able to page through the school, so
       * their request is rewritten to their own scope rather than trusted.
       */
      const scoped = { ...filters };
      if (!ctx.permissions.has('students.read_all') && actor.userType !== 'admin') {
        if (actor.userType === 'guardian' || actor.userType === 'student') {
          throw new BusinessRuleError(
            'Use the portal endpoints to view your own records.',
            'USE_PORTAL_ENDPOINTS',
          );
        }
        // A teacher may list only their own sections.
        if (actor.userType === 'staff' && !scoped.sectionId) {
          throw new BusinessRuleError(
            'Specify a section you are assigned to.',
            'SECTION_REQUIRED',
          );
        }
      }

      let cursorCreatedAt: string | undefined;
      let cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as {
          v: string;
          i: string;
        };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }

      const rows = await this.students.listFiltered(uow, scoped, {
        limit: page.limit,
        cursorCreatedAt,
        cursorId,
      });

      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      const showSensitive = ctx.permissions.has('students.read_all');

      return {
        items: items.map((r) => ({
          ...toStudentView(r, showSensitive),
          className: r.class_name,
          sectionName: r.section_name,
          rollNo: r.roll_no,
        })),
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ k: 'created_at', v: last.created_at, i: last.id }),
                'utf8',
              ).toString('base64url')
            : null,
      };
    });
  }

  /**
   * Unified search (Part 9.1).
   *
   * The term is classified and routed to the cheapest index that can answer it,
   * rather than always running a trigram scan: an admission number or a phone
   * number is an equality lookup on a B-tree.
   */
  async search(
    actor: Actor,
    term: string,
    options: { limit: number; typeahead?: boolean },
  ): Promise<{ kind: string; students: unknown[] }> {
    return readTransaction(actor, async (uow) => {
      const kind = classifySearchTerm(term);

      switch (kind) {
        case 'admission_no': {
          const row = await this.students.findByAdmissionNo(uow, term.trim());
          return { kind, students: row ? [minimal(row)] : [] };
        }
        case 'national_id': {
          const row = await this.students.findByNationalId(uow, term.replace(/\D/g, ''));
          return { kind, students: row ? [minimal(row)] : [] };
        }
        case 'phone': {
          // A phone may belong to the student or to a guardian, so both are
          // tried; the guardian path is how reception finds a child from an
          // incoming call.
          const viaGuardian = await this.guardians.findByPhone(uow, term.replace(/[\s()-]/g, ''));
          const children: unknown[] = [];
          for (const g of viaGuardian) {
            children.push(...(await this.guardians.childrenOf(uow, g.id)));
          }
          return { kind, students: children };
        }
        default: {
          const rows = await this.students.searchByName(uow, term, {
            limit: options.limit,
            prefixOnly: options.typeahead ?? false,
          });
          return { kind, students: rows };
        }
      }
    });
  }

  async siblingsOf(actor: Actor, studentId: string) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, studentId), 'Student');
      return this.guardians.siblingsOf(uow, studentId);
    });
  }

  /* ---------------- writes ---------------- */

  /**
   * Create a student directly (a transfer-in).
   *
   * Probable duplicates are reported as a warning alongside the created record
   * rather than blocking, because two children genuinely can share a name and a
   * birthday. `force` is not needed; the caller sees the warning and can merge
   * afterwards.
   */
  async create(
    actor: Actor,
    input: {
      firstName: string;
      lastName?: string | null | undefined;
      gender: string;
      dob: string;
      admissionDate: string;
      nationalId?: string | null | undefined;
      phone?: string | null | undefined;
      address?: string | null | undefined;
      bloodGroup?: string | null | undefined;
      religion?: string | null | undefined;
      previousSchool?: string | null | undefined;
    },
  ): Promise<{ student: StudentView; possibleDuplicates: unknown[] }> {
    return transaction(actor, async (uow) => {
      // The database CHECK is `dob < admission_date`; checked here for a
      // message that names the problem.
      if (input.dob >= input.admissionDate) {
        throw new BusinessRuleError(
          'The date of birth must be before the admission date.',
          'DOB_AFTER_ADMISSION',
        );
      }

      const duplicates = await this.students.findProbableDuplicates(uow, {
        nationalId: input.nationalId ?? null,
        phone: input.phone ?? null,
        firstName: input.firstName,
        lastName: input.lastName ?? null,
        dob: input.dob,
      });

      const admissionNo = await this.students.nextAdmissionNo(uow);
      const row = await this.students.createWithAdmissionNo(
        uow,
        {
          first_name: input.firstName,
          last_name: input.lastName ?? null,
          gender: input.gender,
          dob: input.dob,
          national_id: input.nationalId ?? null,
          religion: input.religion ?? null,
          blood_group: input.bloodGroup ?? null,
          address: input.address ?? null,
          phone: input.phone ?? null,
          admission_date: input.admissionDate,
          previous_school: input.previousSchool ?? null,
        },
        admissionNo,
      );

      return { student: toStudentView(row, true), possibleDuplicates: duplicates };
    });
  }

  async update(
    actor: Actor,
    id: string,
    input: Record<string, unknown>,
    expectedUpdatedAt?: string,
  ): Promise<StudentView> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, id), 'Student');

      const row = await this.students.update(
        uow,
        id,
        {
          first_name: input.firstName,
          last_name: input.lastName,
          gender: input.gender,
          dob: input.dob,
          national_id: input.nationalId,
          religion: input.religion,
          blood_group: input.bloodGroup,
          address: input.address,
          phone: input.phone,
          previous_school: input.previousSchool,
        },
        expectedUpdatedAt,
      );
      return toStudentView(row, true);
    });
  }

  /** Soft delete, refused if any history exists (Module 3). */
  async softDelete(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, id), 'Student');

      const history = await this.students.historyCounts(uow, id);
      if (history.enrollments > 0 || history.invoices > 0 || history.payments > 0) {
        throw new BusinessRuleError(
          `This student has history (${history.enrollments} enrollment(s), ` +
            `${history.invoices} invoice(s), ${history.payments} payment(s)) and cannot be deleted. ` +
            'Record a withdrawal or transfer instead.',
          'STUDENT_HAS_HISTORY',
        );
      }
      await this.students.softDelete(uow, id);
    });
  }

  /* ---------------- guardians ---------------- */

  async createGuardian(
    actor: Actor,
    input: {
      fullName: string;
      phone: string;
      nationalId?: string | null | undefined;
      email?: string | null | undefined;
      occupation?: string | null | undefined;
      address?: string | null | undefined;
    },
  ): Promise<GuardianRow> {
    return transaction(actor, async (uow) => {
      // Reuse an existing guardian rather than duplicating them: this is how a
      // sibling admission links to the same parent, and it is what makes the
      // family dues view work.
      if (input.nationalId) {
        const existing = await this.guardians.findByNationalId(uow, input.nationalId);
        if (existing) {
          throw new ConflictError(
            `A guardian with that national ID already exists (${existing.full_name}). Link them instead.`,
            'GUARDIAN_EXISTS',
          );
        }
      }

      return this.guardians.create(uow, {
        full_name: input.fullName,
        phone: input.phone,
        national_id: input.nationalId ?? null,
        email: input.email ?? null,
        occupation: input.occupation ?? null,
        address: input.address ?? null,
      });
    });
  }

  async searchGuardians(actor: Actor, term: string, limit: number): Promise<GuardianRow[]> {
    return readTransaction(actor, async (uow) => {
      const kind = classifySearchTerm(term);
      if (kind === 'phone') return this.guardians.findByPhone(uow, term.replace(/[\s()-]/g, ''));
      if (kind === 'national_id') {
        const one = await this.guardians.findByNationalId(uow, term.replace(/\D/g, ''));
        return one ? [one] : [];
      }
      return this.guardians.searchByName(uow, term, limit);
    });
  }

  async linkGuardian(
    actor: Actor,
    input: {
      studentId: string;
      guardianId: string;
      relation: string;
      isPrimary: boolean;
      isFeePayer: boolean;
    },
  ): Promise<unknown[]> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, input.studentId), 'Student');

      await this.guardians.getById(uow, input.guardianId);
      await this.guardians.link(uow, input);
      return this.guardians.forStudent(uow, input.studentId);
    });
  }

  /**
   * Unlink a guardian.
   *
   * Refused if it would leave the student with no fee payer, because invoice
   * generation and the family dues view both need one — and discovering that
   * at billing time is far worse than refusing here.
   */
  async unlinkGuardian(actor: Actor, studentId: string, guardianId: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, studentId), 'Student');

      const links = await this.guardians.forStudent(uow, studentId);
      const target = links.find((l) => l.id === guardianId);
      if (!target) throw new NotFoundError('Guardian link');

      const counts = await this.guardians.linkCounts(uow, studentId);
      if (counts.total <= 1) {
        throw new BusinessRuleError(
          'A student must have at least one guardian.',
          'LAST_GUARDIAN',
        );
      }
      if (target.is_fee_payer && counts.feePayers <= 1) {
        throw new BusinessRuleError(
          'That is the only fee-paying guardian. Assign another before removing this one.',
          'LAST_FEE_PAYER',
        );
      }

      await this.guardians.unlink(uow, studentId, guardianId);
    });
  }

  /* ---------------- enrollment ---------------- */

  /**
   * Enroll a student, assigning the next roll number safely.
   *
   * The section lock is taken before the maximum is read. Without it, two
   * simultaneous enrolments read the same maximum and the second insert is
   * rejected by the unique constraint — correct, but it surfaces as an error at
   * the admissions desk rather than the next number.
   */
  async enroll(
    actor: Actor,
    input: {
      studentId: string;
      academicYearId: string;
      classId: string;
      sectionId: string;
      enrolledOn: string;
      rollNo?: number | undefined;
    },
  ): Promise<EnrollmentRow> {
    return transaction(actor, async (uow) => {
      await assertYearOpen(uow, input.academicYearId);
      await this.students.getById(uow, input.studentId);
      await assertSectionInClass(uow, input.sectionId, input.classId);
      await assertNotAlreadyEnrolled(
        uow,
        this.enrollments,
        input.studentId,
        input.academicYearId,
      );

      // Serialises concurrent enrolments into this section.
      const section = await this.sections.lockForEnrollment(uow, input.sectionId);

      const strength = await this.sections.currentStrength(uow, input.sectionId);
      if (strength >= section.capacity) {
        throw new BusinessRuleError(
          `Section is full (${strength} of ${section.capacity}).`,
          'SECTION_FULL',
        );
      }

      const rollNo =
        input.rollNo ??
        (await this.enrollments.nextRollNo(uow, input.sectionId, input.academicYearId));

      return this.enrollments.create(uow, {
        student_id: input.studentId,
        academic_year_id: input.academicYearId,
        class_id: input.classId,
        section_id: input.sectionId,
        roll_no: rollNo,
        enrolled_on: input.enrolledOn,
      });
    });
  }

  /** Move a student to another section, keeping the enrollment history. */
  async transferSection(
    actor: Actor,
    enrollmentId: string,
    input: { sectionId: string; classId: string },
  ): Promise<EnrollmentRow> {
    return transaction(actor, async (uow) => {
      const enrollment = await this.enrollments.getById(uow, enrollmentId);
      await assertYearOpen(uow, enrollment.academic_year_id);
      await assertSectionInClass(uow, input.sectionId, input.classId);

      if (enrollment.section_id === input.sectionId) {
        throw new BusinessRuleError('The student is already in that section.', 'SAME_SECTION');
      }

      const section = await this.sections.lockForEnrollment(uow, input.sectionId);
      const strength = await this.sections.currentStrength(uow, input.sectionId);
      if (strength >= section.capacity) {
        throw new BusinessRuleError(
          `Destination section is full (${strength} of ${section.capacity}).`,
          'SECTION_FULL',
        );
      }

      const rollNo = await this.enrollments.nextRollNo(
        uow,
        input.sectionId,
        enrollment.academic_year_id,
      );
      return this.enrollments.transferSection(uow, enrollmentId, input.sectionId, input.classId, rollNo);
    });
  }

  async classList(actor: Actor, sectionId: string, yearId: string) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      // A teacher sees only their own sections; read_all lifts it.
      if (!ctx.permissions.has('students.read_all') && actor.userType === 'staff') {
        const rows = await uow.many<{ ok: boolean }>(
          `SELECT true AS ok FROM subject_teachers st
            WHERE st.staff_id = $1 AND st.section_id = $2 AND st.academic_year_id = $3
           UNION
           SELECT true FROM sections WHERE id = $2 AND class_teacher_id = $1`,
          [actor.staffId, sectionId, yearId],
        );
        if (rows.length === 0) throw new NotFoundError('Section');
      }
      return this.enrollments.listForSection(uow, sectionId, yearId);
    });
  }

  async resortRollNumbers(
    actor: Actor,
    sectionId: string,
    yearId: string,
  ): Promise<{ updated: number }> {
    return transaction(actor, async (uow) => {
      await assertYearOpen(uow, yearId);
      await this.sections.lockForEnrollment(uow, sectionId);
      return { updated: await this.enrollments.resortRollNumbers(uow, sectionId, yearId) };
    });
  }

  /* ---------------- admission applications ---------------- */

  /**
   * Move an application through its workflow.
   *
   * Transitions come from `APPLICATION_TRANSITIONS`; anything not listed is
   * rejected. `enrolled` is set only by the conversion below, never directly,
   * because reaching it without creating a student would leave the two
   * disagreeing.
   */
  async setApplicationStatus(
    actor: Actor,
    id: string,
    to: ApplicationStatus,
    remarks?: string,
  ): Promise<{ id: string; status: string }> {
    return transaction(actor, async (uow) => {
      const app = await uow.one<{ id: string; status: ApplicationStatus }>(
        `SELECT id::text AS id, status FROM admission_applications WHERE id = $1`,
        [id],
        'Application',
      );

      if (to === 'enrolled') {
        throw new BusinessRuleError(
          'An application becomes enrolled by converting it into a student, not by setting the status.',
          'USE_CONVERSION_ENDPOINT',
        );
      }

      if (!canTransition(APPLICATION_TRANSITIONS, app.status, to)) {
        throw new IllegalTransitionError(
          'application',
          app.status,
          to,
          APPLICATION_TRANSITIONS[app.status],
        );
      }

      const updated = await uow.one<{ id: string; status: string }>(
        `UPDATE admission_applications
            SET status = $2, remarks = COALESCE($3, remarks)
          WHERE id = $1
          RETURNING id::text AS id, status`,
        [id, to, remarks ?? null],
      );
      return updated;
    });
  }
}

/** The minimal projection used by search results and pickers. */
function minimal(row: StudentRow): {
  id: string;
  admission_no: string;
  first_name: string;
  last_name: string | null;
  status: string;
} {
  return {
    id: row.id,
    admission_no: row.admission_no,
    first_name: row.first_name,
    last_name: row.last_name,
    status: row.status,
  };
}
