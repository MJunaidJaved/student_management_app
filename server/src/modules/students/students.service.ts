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
  AdmissionApplicationRepository,
  EnrollmentRepository,
  GuardianRepository,
  StudentRepository,
  assertNotAlreadyEnrolled,
  assertSectionInClass,
  type AdmissionApplicationRow,
  type EnrollmentRow,
  type GuardianRow,
  type StudentRow,
} from './students.repository';
import type { StudentStatus } from '../../core/db/enums';

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

export type GuardianView = {
  id: string;
  fullName: string;
  nationalId: string | null;
  phone: string;
  email: string | null;
  occupation: string | null;
  address: string | null;
};

/** `GuardianRow` is never returned to a client as-is (Part 4: no raw rows). */
function toGuardianView(row: GuardianRow): GuardianView {
  return {
    id: row.id,
    fullName: row.full_name,
    nationalId: row.national_id,
    phone: row.phone,
    email: row.email,
    occupation: row.occupation,
    address: row.address,
  };
}

export type GuardianLinkView = GuardianView & {
  linkId: string;
  relation: string;
  isPrimary: boolean;
  isFeePayer: boolean;
};

function toGuardianLinkView(
  row: GuardianRow & { relation: string; is_primary: boolean; is_fee_payer: boolean; link_id: string },
): GuardianLinkView {
  return {
    ...toGuardianView(row),
    linkId: row.link_id,
    relation: row.relation,
    isPrimary: row.is_primary,
    isFeePayer: row.is_fee_payer,
  };
}

export type EnrollmentView = {
  id: string;
  studentId: string;
  academicYearId: string;
  classId: string;
  sectionId: string;
  rollNo: number;
  status: string;
  enrolledOn: string;
};

function toEnrollmentView(row: EnrollmentRow): EnrollmentView {
  return {
    id: row.id,
    studentId: row.student_id,
    academicYearId: row.academic_year_id,
    classId: row.class_id,
    sectionId: row.section_id,
    rollNo: row.roll_no,
    status: row.status,
    enrolledOn: row.enrolled_on,
  };
}

function toClassListEntry(
  row: EnrollmentRow & { first_name: string; last_name: string | null; admission_no: string },
): EnrollmentView & { firstName: string; lastName: string | null; admissionNo: string } {
  return {
    ...toEnrollmentView(row),
    firstName: row.first_name,
    lastName: row.last_name,
    admissionNo: row.admission_no,
  };
}

export type AdmissionApplicationView = {
  id: string;
  applicationNo: string;
  applicantName: string;
  dob: string;
  gender: string | null;
  guardianName: string;
  guardianPhone: string;
  appliedClassId: string;
  status: string;
  studentId: string | null;
  remarks: string | null;
};

function toApplicationView(row: AdmissionApplicationRow): AdmissionApplicationView {
  return {
    id: row.id,
    applicationNo: row.application_no,
    applicantName: row.applicant_name,
    dob: row.dob,
    gender: row.gender,
    guardianName: row.guardian_name,
    guardianPhone: row.guardian_phone,
    appliedClassId: row.applied_class_id,
    status: row.status,
    studentId: row.student_id,
    remarks: row.remarks,
  };
}

export class StudentsService {
  constructor(
    private readonly students: StudentRepository,
    private readonly guardians: GuardianRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly sections: SectionRepository,
    private readonly applications: AdmissionApplicationRepository,
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

  async getById(
    actor: Actor,
    id: string,
  ): Promise<StudentView & { guardians: GuardianLinkView[]; enrollment: EnrollmentView | null }> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, id), 'Student');

      const row = await this.students.getById(uow, id);
      const showSensitive = ctx.permissions.has('students.read_all') || actor.userType === 'admin';

      const enrollment = await this.enrollments.currentForStudent(uow, id);
      return {
        ...toStudentView(row, showSensitive),
        guardians: (await this.guardians.forStudent(uow, id)).map(toGuardianLinkView),
        enrollment: enrollment ? toEnrollmentView(enrollment) : null,
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
          const children: { id: string; admissionNo: string; firstName: string; lastName: string | null; relation: string; isPrimary: boolean }[] = [];
          for (const g of viaGuardian) {
            const rows = await this.guardians.childrenOf(uow, g.id);
            children.push(
              ...rows.map((r) => ({
                id: r.id,
                admissionNo: r.admission_no,
                firstName: r.first_name,
                lastName: r.last_name,
                relation: r.relation,
                isPrimary: r.is_primary,
              })),
            );
          }
          return { kind, students: children };
        }
        default: {
          const rows = await this.students.searchByName(uow, term, {
            limit: options.limit,
            prefixOnly: options.typeahead ?? false,
          });
          return { kind, students: rows.map(minimal) };
        }
      }
    });
  }

  async siblingsOf(
    actor: Actor,
    studentId: string,
  ): Promise<{ id: string; admissionNo: string; firstName: string; lastName: string | null }[]> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canView(ctx, studentId), 'Student');
      const rows = await this.guardians.siblingsOf(uow, studentId);
      return rows.map((r) => ({
        id: r.id,
        admissionNo: r.admission_no,
        firstName: r.first_name,
        lastName: r.last_name,
      }));
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
  ): Promise<GuardianView> {
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

      const row = await this.guardians.create(uow, {
        full_name: input.fullName,
        phone: input.phone,
        national_id: input.nationalId ?? null,
        email: input.email ?? null,
        occupation: input.occupation ?? null,
        address: input.address ?? null,
      });
      return toGuardianView(row);
    });
  }

  async searchGuardians(actor: Actor, term: string, limit: number): Promise<GuardianView[]> {
    return readTransaction(actor, async (uow) => {
      const kind = classifySearchTerm(term);
      let rows: GuardianRow[];
      if (kind === 'phone') {
        rows = await this.guardians.findByPhone(uow, term.replace(/[\s()-]/g, ''));
      } else if (kind === 'national_id') {
        const one = await this.guardians.findByNationalId(uow, term.replace(/\D/g, ''));
        rows = one ? [one] : [];
      } else {
        rows = await this.guardians.searchByName(uow, term, limit);
      }
      return rows.map(toGuardianView);
    });
  }

  /** The reverse of a student's guardian list: which students a guardian is linked to. */
  async studentsForGuardian(
    actor: Actor,
    guardianId: string,
  ): Promise<{ id: string; admissionNo: string; firstName: string; lastName: string | null; relation: string; isPrimary: boolean }[]> {
    return readTransaction(actor, async (uow) => {
      await this.guardians.getById(uow, guardianId);
      const rows = await this.guardians.childrenOf(uow, guardianId);
      return rows.map((r) => ({
        id: r.id,
        admissionNo: r.admission_no,
        firstName: r.first_name,
        lastName: r.last_name,
        relation: r.relation,
        isPrimary: r.is_primary,
      }));
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
  ): Promise<GuardianLinkView[]> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, input.studentId), 'Student');

      await this.guardians.getById(uow, input.guardianId);
      await this.guardians.link(uow, input);
      return (await this.guardians.forStudent(uow, input.studentId)).map(toGuardianLinkView);
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
  ): Promise<EnrollmentView> {
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

      const row = await this.enrollments.create(uow, {
        student_id: input.studentId,
        academic_year_id: input.academicYearId,
        class_id: input.classId,
        section_id: input.sectionId,
        roll_no: rollNo,
        enrolled_on: input.enrolledOn,
      });
      return toEnrollmentView(row);
    });
  }

  /** Move a student to another section, keeping the enrollment history. */
  async transferSection(
    actor: Actor,
    enrollmentId: string,
    input: { sectionId: string; classId: string },
  ): Promise<EnrollmentView> {
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
      const row = await this.enrollments.transferSection(uow, enrollmentId, input.sectionId, input.classId, rollNo);
      return toEnrollmentView(row);
    });
  }

  async classList(
    actor: Actor,
    sectionId: string,
    yearId: string,
  ): Promise<ReturnType<typeof toClassListEntry>[]> {
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
      const rows = await this.enrollments.listForSection(uow, sectionId, yearId);
      return rows.map(toClassListEntry);
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
   * Record an enquiry or application.
   *
   * Always created at `enquiry`, the workflow's start state — the database
   * column default agrees, but it is set explicitly here rather than relied
   * on, since `APPLICATION_TRANSITIONS` is the single source of truth for
   * where the workflow begins.
   */
  async createApplication(
    actor: Actor,
    input: {
      applicantName: string;
      dob: string;
      gender?: string | null | undefined;
      guardianName: string;
      guardianPhone: string;
      appliedClassId: string;
      remarks?: string | null | undefined;
    },
  ): Promise<AdmissionApplicationView> {
    return transaction(actor, async (uow) => {
      const row = await this.applications.create(uow, {
        applicant_name: input.applicantName,
        dob: input.dob,
        gender: input.gender ?? null,
        guardian_name: input.guardianName,
        guardian_phone: input.guardianPhone,
        applied_class_id: input.appliedClassId,
        remarks: input.remarks ?? null,
      });
      return toApplicationView(row);
    });
  }

  async listApplications(
    actor: Actor,
    filters: { status?: string | undefined; appliedClassId?: string | undefined },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: AdmissionApplicationView[]; nextCursor: string | null; hasMore: boolean }> {
    return readTransaction(actor, async (uow) => {
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

      const rows = await this.applications.listFiltered(uow, filters, {
        limit: page.limit,
        cursorCreatedAt,
        cursorId,
      });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];

      return {
        items: items.map(toApplicationView),
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({ v: last.created_at, i: last.id }),
                'utf8',
              ).toString('base64url')
            : null,
      };
    });
  }

  async getApplication(actor: Actor, id: string): Promise<AdmissionApplicationView> {
    return readTransaction(actor, async (uow) => toApplicationView(await this.applications.getById(uow, id)));
  }

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
  ): Promise<AdmissionApplicationView> {
    return transaction(actor, async (uow) => {
      const app = await this.applications.getById(uow, id);

      if (to === 'enrolled') {
        throw new BusinessRuleError(
          'An application becomes enrolled by converting it into a student, not by setting the status.',
          'USE_CONVERSION_ENDPOINT',
        );
      }

      if (!canTransition(APPLICATION_TRANSITIONS, app.status as ApplicationStatus, to)) {
        throw new IllegalTransitionError(
          'application',
          app.status,
          to,
          APPLICATION_TRANSITIONS[app.status as ApplicationStatus],
        );
      }

      return toApplicationView(await this.applications.setStatus(uow, id, to, remarks ?? null));
    });
  }

  /**
   * Convert an accepted application into an enrolled student.
   *
   * One transaction, as Module 3 requires: the student, the guardian link and
   * the first enrollment are created together, and the application is marked
   * `enrolled` and linked to the new student in the same statement set. A
   * failure at any step rolls all of it back — there is never a student
   * without an enrollment, or an application that says "enrolled" with
   * nothing behind it.
   *
   * The class is the one the application was made against; it is not an
   * input, so a caller cannot enrol an applicant into a different class than
   * what was accepted. An existing guardian can be linked by id, or a new one
   * is created from the application's own guardian fields.
   */
  async convertApplication(
    actor: Actor,
    applicationId: string,
    input: {
      academicYearId: string;
      sectionId: string;
      enrolledOn: string;
      guardianId?: string | undefined;
      relation?: string | undefined;
    },
  ): Promise<{ student: StudentView; enrollment: EnrollmentView; guardian: GuardianView; possibleDuplicates: unknown[] }> {
    return transaction(actor, async (uow) => {
      const app = await this.applications.getById(uow, applicationId);
      if (app.status !== 'accepted') {
        throw new IllegalTransitionError('application', app.status, 'enrolled', ['accepted']);
      }

      await assertYearOpen(uow, input.academicYearId);
      await assertSectionInClass(uow, input.sectionId, app.applied_class_id);

      // Splitting on the first space is a deliberate simplification: the
      // application stores one free-text name, but `students` requires a
      // separate first name. Anything after the first word is the surname.
      const [firstName, ...rest] = app.applicant_name.trim().split(/\s+/);
      const lastName = rest.length > 0 ? rest.join(' ') : null;

      const duplicates = await this.students.findProbableDuplicates(uow, {
        firstName: firstName ?? app.applicant_name,
        lastName,
        dob: app.dob,
        phone: null,
        nationalId: null,
      });

      const admissionNo = await this.students.nextAdmissionNo(uow);
      const student = await this.students.createWithAdmissionNo(
        uow,
        {
          first_name: firstName ?? app.applicant_name,
          last_name: lastName,
          gender: app.gender ?? 'other',
          dob: app.dob,
          admission_date: input.enrolledOn,
        },
        admissionNo,
      );

      const guardian = input.guardianId
        ? await this.guardians.getById(uow, input.guardianId)
        : await this.guardians.create(uow, {
            full_name: app.guardian_name,
            phone: app.guardian_phone,
          });

      await this.guardians.link(uow, {
        studentId: student.id,
        guardianId: guardian.id,
        relation: input.relation ?? 'guardian',
        isPrimary: true,
        isFeePayer: true,
      });

      await assertNotAlreadyEnrolled(uow, this.enrollments, student.id, input.academicYearId);
      const section = await this.sections.lockForEnrollment(uow, input.sectionId);
      const strength = await this.sections.currentStrength(uow, input.sectionId);
      if (strength >= section.capacity) {
        throw new BusinessRuleError(
          `Section is full (${strength} of ${section.capacity}).`,
          'SECTION_FULL',
        );
      }
      const rollNo = await this.enrollments.nextRollNo(uow, input.sectionId, input.academicYearId);
      const enrollment = await this.enrollments.create(uow, {
        student_id: student.id,
        academic_year_id: input.academicYearId,
        class_id: app.applied_class_id,
        section_id: input.sectionId,
        roll_no: rollNo,
        enrolled_on: input.enrolledOn,
      });

      await this.applications.markEnrolled(uow, applicationId, student.id);

      return {
        student: toStudentView(student, true),
        enrollment: toEnrollmentView(enrollment),
        guardian: toGuardianView(guardian),
        possibleDuplicates: duplicates,
      };
    });
  }

  /* ---------------- leaving ---------------- */

  /**
   * Record a withdrawal, transfer-out or graduation.
   *
   * Deliberately simple for this phase: a status change plus one audit-trail
   * row, no certificate PDF. `student_leaving_records.student_id` is unique —
   * the schema allows exactly one leaving record per student ever — so a
   * second attempt is refused with a clear message rather than the raw
   * constraint error.
   */
  async leaveSchool(
    actor: Actor,
    studentId: string,
    input: { status: Exclude<StudentStatus, 'active'>; leavingDate: string; reason?: string | undefined },
  ): Promise<StudentView> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.policy.canEdit(ctx, studentId), 'Student');

      const student = await this.students.getById(uow, studentId);
      if (student.status !== 'active') {
        throw new BusinessRuleError(
          `This student is already ${student.status}.`,
          'STUDENT_NOT_ACTIVE',
        );
      }

      const existingRecord = await uow.maybeOne<{ id: string }>(
        `SELECT id FROM student_leaving_records WHERE student_id = $1`,
        [studentId],
      );
      if (existingRecord) {
        throw new ConflictError(
          'A leaving record already exists for this student.',
          'LEAVING_RECORD_EXISTS',
        );
      }

      await this.students.setStatus(uow, studentId, input.status);

      const enrollment = await this.enrollments.findActiveForStudent(uow, studentId);
      if (enrollment) {
        await this.enrollments.setStatus(uow, enrollment.id, input.status);
      }

      await uow.count(
        `INSERT INTO student_leaving_records (student_id, leaving_date, reason, issued_by)
         VALUES ($1, $2, $3, $4)`,
        [studentId, input.leavingDate, input.reason ?? null, actor.userId],
      );

      const row = await this.students.getById(uow, studentId);
      return toStudentView(row, true);
    });
  }
}

/** The minimal projection used by search results and pickers. */
function minimal(row: Pick<StudentRow, 'id' | 'admission_no' | 'first_name' | 'last_name' | 'status'>): {
  id: string;
  admissionNo: string;
  firstName: string;
  lastName: string | null;
  status: string;
} {
  return {
    id: row.id,
    admissionNo: row.admission_no,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
  };
}
