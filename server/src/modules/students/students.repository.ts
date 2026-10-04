/**
 * Students, guardians and enrollments.
 *
 * The search queries interpolate the expression constants from
 * core/search/search-expressions rather than retyping them, because an
 * expression index is only used when the query repeats it exactly.
 */

import { BaseRepository, type SoftDeletableRow, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder, type SortMap } from '../../core/db/query-builder';
import { BusinessRuleError, ConflictError } from '../../core/errors';
import {
  GUARDIAN_NAME_EXPR,
  STUDENT_NAME_EXPR,
  containsPattern,
  normalizeName,
  prefixPattern,
} from '../../core/search/search-expressions';

export type StudentRow = SoftDeletableRow & {
  admission_no: string;
  first_name: string;
  last_name: string | null;
  gender: string;
  dob: string;
  national_id: string | null;
  religion: string | null;
  blood_group: string | null;
  address: string | null;
  phone: string | null;
  photo_path: string | null;
  admission_date: string;
  previous_school: string | null;
  status: string;
};

export class StudentRepository extends BaseRepository<StudentRow> {
  protected readonly table = 'students';
  protected readonly writableColumns = [
    'first_name',
    'last_name',
    'gender',
    'dob',
    'national_id',
    'religion',
    'blood_group',
    'address',
    'phone',
    'photo_path',
    'admission_date',
    'previous_school',
  ] as const;
  // admission_no comes from a sequence and status changes through the leaving
  // and promotion workflows, so neither is client-writable.
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = {
    created_at: { column: 'students.created_at', index: 'students_pkey' },
    admission_no: { column: 'students.admission_no', index: 'students_admission_no_key' },
    first_name: { column: 'students.first_name', index: 'ix_students_name' },
  };

  /** Next admission number, from the sequence (Part 9.5). */
  async nextAdmissionNo(uow: Uow): Promise<string> {
    const seq = await uow.nextSequenceValue('seq_admission_no');
    // Year-prefixed so it reads as a school reference rather than a raw counter.
    return `${new Date().getFullYear()}-${seq.padStart(4, '0')}`;
  }

  async createWithAdmissionNo(
    uow: Uow,
    data: Record<string, unknown>,
    admissionNo: string,
  ): Promise<StudentRow> {
    return uow.one<StudentRow>(
      `INSERT INTO students
         (admission_no, first_name, last_name, gender, dob, national_id, religion,
          blood_group, address, phone, photo_path, admission_date, previous_school, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
       RETURNING *`,
      [
        admissionNo,
        data.first_name,
        data.last_name ?? null,
        data.gender,
        data.dob,
        data.national_id ?? null,
        data.religion ?? null,
        data.blood_group ?? null,
        data.address ?? null,
        data.phone ?? null,
        data.photo_path ?? null,
        data.admission_date,
        data.previous_school ?? null,
      ],
      'Student',
    );
  }

  async setStatus(uow: Uow, id: string, status: string): Promise<void> {
    await uow.count(`UPDATE students SET status = $2 WHERE id = $1`, [id, status]);
  }

  /**
   * Filtered, keyset-paginated student list.
   *
   * Filters on the current enrollment rather than on the student, because
   * "students in section 5-A" is a property of this year's enrollment. The join
   * is to the current year only.
   */
  async listFiltered(
    uow: Uow,
    filters: {
      classId?: string | undefined;
      sectionId?: string | undefined;
      status?: string | undefined;
      gender?: string | undefined;
      academicYearId?: string | undefined;
      guardianPhone?: string | undefined;
    },
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<(StudentRow & { class_name: string | null; section_name: string | null; roll_no: number | null })[]> {
    const where = new ConditionBuilder();
    where.add('s.deleted_at IS NULL');
    where.addIf(filters.status, 's.status = ?', filters.status);
    where.addIf(filters.gender, 's.gender = ?', filters.gender);
    where.addIf(filters.classId, 'e.class_id = ?', filters.classId);
    where.addIf(filters.sectionId, 'e.section_id = ?', filters.sectionId);

    if (filters.guardianPhone) {
      // Normalised the same way it is stored, or the comparison misses.
      where.add(
        `EXISTS (SELECT 1 FROM student_guardians sg
                   JOIN guardians g ON g.id = sg.guardian_id
                  WHERE sg.student_id = s.id AND g.phone = ?)`,
        filters.guardianPhone,
      );
    }

    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(s.created_at, s.id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }

    return uow.many(
      `SELECT s.*,
              c.name    AS class_name,
              sec.name  AS section_name,
              e.roll_no AS roll_no
         FROM students s
    LEFT JOIN student_enrollments e
           ON e.student_id = s.id
          AND e.academic_year_id = COALESCE(
                $${where.params().length + 1}::bigint,
                (SELECT id FROM academic_years WHERE is_current LIMIT 1))
    LEFT JOIN sections sec ON sec.id = e.section_id
    LEFT JOIN classes c    ON c.id = e.class_id
        ${where.where()}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ${page.limit + 1}`,
      [...where.params(), filters.academicYearId ?? null],
    );
  }

  /**
   * Name search using the trigram index.
   *
   * `prefix` is a cheaper B-tree range scan and is what typeahead uses;
   * `contains` needs the GIN trigram index. Both reproduce the indexed
   * expression exactly.
   */
  async searchByName(
    uow: Uow,
    term: string,
    options: { limit: number; prefixOnly?: boolean },
  ): Promise<Pick<StudentRow, 'id' | 'admission_no' | 'first_name' | 'last_name' | 'status'>[]> {
    const pattern = options.prefixOnly ? prefixPattern(term) : containsPattern(term);
    return uow.many(
      `SELECT id, admission_no, first_name, last_name, status
         FROM students
        WHERE deleted_at IS NULL
          AND ${STUDENT_NAME_EXPR} LIKE $1
        ORDER BY ${STUDENT_NAME_EXPR}
        LIMIT $2`,
      [pattern, options.limit],
    );
  }

  async findByAdmissionNo(uow: Uow, admissionNo: string): Promise<StudentRow | null> {
    return uow.maybeOne<StudentRow>(
      `SELECT * FROM students WHERE admission_no = $1 AND deleted_at IS NULL`,
      [admissionNo],
    );
  }

  async findByNationalId(uow: Uow, nationalId: string): Promise<StudentRow | null> {
    return uow.maybeOne<StudentRow>(
      `SELECT * FROM students WHERE national_id = $1 AND deleted_at IS NULL`,
      [nationalId],
    );
  }

  /**
   * Probable duplicates at admission time (Part 9.4).
   *
   * Three independent signals: same national ID (conclusive), same phone, or
   * the same normalised name AND date of birth. Reported as a warning rather
   * than a refusal, because genuine duplicates of name plus birthday do occur.
   */
  async findProbableDuplicates(
    uow: Uow,
    candidate: { nationalId?: string | null; phone?: string | null; firstName: string; lastName?: string | null; dob: string },
  ): Promise<{ id: string; admission_no: string; first_name: string; last_name: string | null; reason: string }[]> {
    const fullName = normalizeName(`${candidate.firstName} ${candidate.lastName ?? ''}`);
    return uow.many(
      `SELECT id, admission_no, first_name, last_name,
              CASE
                WHEN national_id IS NOT NULL AND national_id = $1 THEN 'same national ID'
                WHEN phone IS NOT NULL AND phone = $2 THEN 'same phone number'
                ELSE 'same name and date of birth'
              END AS reason
         FROM students
        WHERE deleted_at IS NULL
          AND (
            ($1::text IS NOT NULL AND national_id = $1)
            OR ($2::text IS NOT NULL AND phone = $2)
            OR (${STUDENT_NAME_EXPR} = $3 AND dob = $4::date)
          )
        LIMIT 10`,
      [candidate.nationalId ?? null, candidate.phone ?? null, fullName, candidate.dob],
    );
  }

  /** Does this student have any history that forbids a hard delete? */
  async historyCounts(
    uow: Uow,
    studentId: string,
  ): Promise<{ enrollments: number; invoices: number; payments: number }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM student_enrollments WHERE student_id = $1) AS enrollments,
         (SELECT count(*)::int FROM fee_invoices i
            JOIN student_enrollments e ON e.id = i.enrollment_id
           WHERE e.student_id = $1) AS invoices,
         (SELECT count(*)::int FROM payments p
            JOIN payment_allocations pa ON pa.payment_id = p.id
            JOIN fee_invoices i ON i.id = pa.invoice_id
            JOIN student_enrollments e ON e.id = i.enrollment_id
           WHERE e.student_id = $1) AS payments`,
      [studentId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Guardians
 * ------------------------------------------------------------------ */

export type GuardianRow = SoftDeletableRow & {
  full_name: string;
  national_id: string | null;
  phone: string;
  email: string | null;
  occupation: string | null;
  address: string | null;
};

export class GuardianRepository extends BaseRepository<GuardianRow> {
  protected readonly table = 'guardians';
  protected readonly writableColumns = [
    'full_name',
    'national_id',
    'phone',
    'email',
    'occupation',
    'address',
  ] as const;
  protected readonly defaultSort = 'full_name';
  protected readonly sortable: SortMap = {
    full_name: { column: 'guardians.full_name', index: 'guardians_name_prefix_idx' },
    created_at: { column: 'guardians.created_at', index: 'guardians_pkey' },
  };

  /** Exact phone lookup — the most common guardian search at reception. */
  async findByPhone(uow: Uow, phone: string): Promise<GuardianRow[]> {
    return uow.many<GuardianRow>(
      `SELECT * FROM guardians WHERE phone = $1 AND deleted_at IS NULL ORDER BY full_name`,
      [phone],
    );
  }

  async findByNationalId(uow: Uow, nationalId: string): Promise<GuardianRow | null> {
    return uow.maybeOne<GuardianRow>(
      `SELECT * FROM guardians WHERE national_id = $1 AND deleted_at IS NULL`,
      [nationalId],
    );
  }

  async searchByName(uow: Uow, term: string, limit: number): Promise<GuardianRow[]> {
    return uow.many<GuardianRow>(
      `SELECT * FROM guardians
        WHERE deleted_at IS NULL AND ${GUARDIAN_NAME_EXPR} LIKE $1
        ORDER BY ${GUARDIAN_NAME_EXPR}
        LIMIT $2`,
      [containsPattern(term), limit],
    );
  }

  /** Guardians of a student, with the relationship flags. */
  async forStudent(
    uow: Uow,
    studentId: string,
  ): Promise<(GuardianRow & { relation: string; is_primary: boolean; is_fee_payer: boolean; link_id: string })[]> {
    return uow.many(
      `SELECT g.*, sg.relation, sg.is_primary, sg.is_fee_payer, sg.id::text AS link_id
         FROM student_guardians sg
         JOIN guardians g ON g.id = sg.guardian_id
        WHERE sg.student_id = $1 AND g.deleted_at IS NULL
        ORDER BY sg.is_primary DESC, g.full_name`,
      [studentId],
    );
  }

  /** Children of a guardian — the guardian portal's root query. */
  async childrenOf(
    uow: Uow,
    guardianId: string,
  ): Promise<{ id: string; admission_no: string; first_name: string; last_name: string | null; relation: string; is_primary: boolean }[]> {
    return uow.many(
      `SELECT s.id, s.admission_no, s.first_name, s.last_name, sg.relation, sg.is_primary
         FROM student_guardians sg
         JOIN students s ON s.id = sg.student_id
        WHERE sg.guardian_id = $1 AND s.deleted_at IS NULL
        ORDER BY s.first_name`,
      [guardianId],
    );
  }

  /**
   * Siblings, found through shared guardians (Module 3).
   *
   * Used to offer the sibling discount. DISTINCT because two children can share
   * two guardians and would otherwise appear twice.
   */
  async siblingsOf(
    uow: Uow,
    studentId: string,
  ): Promise<{ id: string; admission_no: string; first_name: string; last_name: string | null }[]> {
    return uow.many(
      `SELECT DISTINCT s.id, s.admission_no, s.first_name, s.last_name
         FROM student_guardians mine
         JOIN student_guardians theirs ON theirs.guardian_id = mine.guardian_id
         JOIN students s ON s.id = theirs.student_id
        WHERE mine.student_id = $1
          AND theirs.student_id <> $1
          AND s.deleted_at IS NULL
        ORDER BY s.first_name`,
      [studentId],
    );
  }

  /**
   * Link a guardian to a student.
   *
   * Enforces "one primary guardian per student" by demoting any existing
   * primary in the same statement pair, rather than letting two primaries exist
   * and having the fee module pick one arbitrarily.
   */
  async link(
    uow: Uow,
    input: {
      studentId: string;
      guardianId: string;
      relation: string;
      isPrimary: boolean;
      isFeePayer: boolean;
    },
  ): Promise<void> {
    if (input.isPrimary) {
      await uow.count(
        `UPDATE student_guardians SET is_primary = false
          WHERE student_id = $1 AND is_primary`,
        [input.studentId],
      );
    }

    await uow.count(
      `INSERT INTO student_guardians (student_id, guardian_id, relation, is_primary, is_fee_payer)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_id, guardian_id) DO UPDATE
         SET relation = EXCLUDED.relation,
             is_primary = EXCLUDED.is_primary,
             is_fee_payer = EXCLUDED.is_fee_payer`,
      [input.studentId, input.guardianId, input.relation, input.isPrimary, input.isFeePayer],
    );
  }

  /** Counts used to enforce the "at least one fee payer" rule on unlink. */
  async linkCounts(
    uow: Uow,
    studentId: string,
  ): Promise<{ total: number; feePayers: number; primaries: number }> {
    return uow.one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE is_fee_payer)::int AS "feePayers",
              count(*) FILTER (WHERE is_primary)::int   AS primaries
         FROM student_guardians WHERE student_id = $1`,
      [studentId],
    );
  }

  async unlink(uow: Uow, studentId: string, guardianId: string): Promise<void> {
    await uow.count(
      `DELETE FROM student_guardians WHERE student_id = $1 AND guardian_id = $2`,
      [studentId, guardianId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Enrollments
 * ------------------------------------------------------------------ */

export type EnrollmentRow = BaseRow & {
  student_id: string;
  academic_year_id: string;
  class_id: string;
  section_id: string;
  roll_no: number;
  status: string;
  enrolled_on: string;
};

export class EnrollmentRepository extends BaseRepository<EnrollmentRow> {
  protected readonly table = 'student_enrollments';
  protected readonly writableColumns = [
    'student_id',
    'academic_year_id',
    'class_id',
    'section_id',
    'roll_no',
    'enrolled_on',
  ] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'roll_no';
  protected readonly sortable: SortMap = {
    roll_no: { column: 'student_enrollments.roll_no', index: 'student_enrollments_pkey' },
    created_at: { column: 'student_enrollments.created_at', index: 'student_enrollments_pkey' },
  };

  /**
   * The next free roll number in a section.
   *
   * MUST be called with the section row already locked
   * (`SectionRepository.lockForEnrollment`). Without that lock two concurrent
   * enrolments both read the same maximum and both try to insert the same roll
   * number; the unique constraint rejects the second, so nothing is corrupted,
   * but one parent gets an error at the counter for no reason they can act on.
   *
   * `max + 1` rather than `count + 1`: after a withdrawal the count drops while
   * the numbers already issued do not, and reusing a number collides.
   */
  async nextRollNo(uow: Uow, sectionId: string, academicYearId: string): Promise<number> {
    const row = await uow.one<{ next: number }>(
      `SELECT COALESCE(MAX(roll_no), 0) + 1 AS next
         FROM student_enrollments
        WHERE section_id = $1 AND academic_year_id = $2`,
      [sectionId, academicYearId],
    );
    return row.next;
  }

  async findForStudentAndYear(
    uow: Uow,
    studentId: string,
    yearId: string,
  ): Promise<EnrollmentRow | null> {
    return uow.maybeOne<EnrollmentRow>(
      `SELECT * FROM student_enrollments WHERE student_id = $1 AND academic_year_id = $2`,
      [studentId, yearId],
    );
  }

  async currentForStudent(uow: Uow, studentId: string): Promise<EnrollmentRow | null> {
    return uow.maybeOne<EnrollmentRow>(
      `SELECT e.* FROM student_enrollments e
         JOIN academic_years ay ON ay.id = e.academic_year_id
        WHERE e.student_id = $1 AND ay.is_current`,
      [studentId],
    );
  }

  /** The class list for a section: what a teacher sees. */
  async listForSection(
    uow: Uow,
    sectionId: string,
    yearId: string,
  ): Promise<(EnrollmentRow & { first_name: string; last_name: string | null; admission_no: string })[]> {
    return uow.many(
      `SELECT e.*, s.first_name, s.last_name, s.admission_no
         FROM student_enrollments e
         JOIN students s ON s.id = e.student_id
        WHERE e.section_id = $1 AND e.academic_year_id = $2 AND s.deleted_at IS NULL
        ORDER BY e.roll_no`,
      [sectionId, yearId],
    );
  }

  async setStatus(uow: Uow, id: string, status: string): Promise<void> {
    await uow.count(`UPDATE student_enrollments SET status = $2 WHERE id = $1`, [id, status]);
  }

  /**
   * Move an enrollment to another section, keeping history.
   *
   * The roll number is reassigned because roll numbers are unique per section
   * and year — carrying the old one across would collide with whoever holds it
   * in the destination.
   */
  async transferSection(
    uow: Uow,
    id: string,
    sectionId: string,
    classId: string,
    rollNo: number,
  ): Promise<EnrollmentRow> {
    return uow.one<EnrollmentRow>(
      `UPDATE student_enrollments
          SET section_id = $2, class_id = $3, roll_no = $4
        WHERE id = $1
        RETURNING *`,
      [id, sectionId, classId, rollNo],
      'Enrollment',
    );
  }

  /** Re-sort a section's roll numbers alphabetically (Module 3). */
  async resortRollNumbers(uow: Uow, sectionId: string, yearId: string): Promise<number> {
    /*
     * Two passes, because roll_no is unique per (section, year): assigning the
     * new numbers directly would collide with numbers still held by other rows
     * mid-update. The first pass moves everything into a negative range that
     * cannot clash, the second brings them back in the right order.
     */
    await uow.count(
      `UPDATE student_enrollments SET roll_no = -roll_no
        WHERE section_id = $1 AND academic_year_id = $2 AND roll_no > 0`,
      [sectionId, yearId],
    );

    return uow.count(
      `UPDATE student_enrollments e
          SET roll_no = ranked.new_roll
         FROM (
           SELECT e2.id,
                  row_number() OVER (
                    ORDER BY lower(s.first_name || ' ' || COALESCE(s.last_name, '')), e2.id
                  ) AS new_roll
             FROM student_enrollments e2
             JOIN students s ON s.id = e2.student_id
            WHERE e2.section_id = $1 AND e2.academic_year_id = $2
         ) ranked
        WHERE e.id = ranked.id`,
      [sectionId, yearId],
    );
  }
}

/** Guard: a student may hold at most one enrollment per academic year. */
export async function assertNotAlreadyEnrolled(
  uow: Uow,
  enrollments: EnrollmentRepository,
  studentId: string,
  yearId: string,
): Promise<void> {
  const existing = await enrollments.findForStudentAndYear(uow, studentId, yearId);
  if (existing) {
    throw new ConflictError(
      'This student is already enrolled for that academic year.',
      'ALREADY_ENROLLED',
    );
  }
}

/** Guard: the section must belong to the class being enrolled into. */
export async function assertSectionInClass(
  uow: Uow,
  sectionId: string,
  classId: string,
): Promise<void> {
  const row = await uow.maybeOne<{ ok: boolean }>(
    `SELECT true AS ok FROM sections
      WHERE id = $1 AND class_id = $2 AND deleted_at IS NULL`,
    [sectionId, classId],
  );
  if (!row) {
    throw new BusinessRuleError(
      'That section does not belong to the chosen class.',
      'SECTION_CLASS_MISMATCH',
    );
  }
}
