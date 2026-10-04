/**
 * Academic setup data access: years, terms, classes, sections, subjects,
 * class-subject mapping, subject-teacher assignment, rooms.
 *
 * Separate small repositories rather than one large one, so each concrete class
 * declares its own writable columns and sortable keys — which is what stops a
 * caller setting a field the service controls.
 */

import { BaseRepository, type BaseRow, type SoftDeletableRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';
import { BusinessRuleError, ConflictError } from '../../core/errors';

/* ------------------------------------------------------------------ *
 * Academic years
 * ------------------------------------------------------------------ */

export type AcademicYearRow = BaseRow & {
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  is_closed: boolean;
};

export class AcademicYearRepository extends BaseRepository<AcademicYearRow> {
  protected readonly table = 'academic_years';
  protected readonly writableColumns = ['name', 'start_date', 'end_date'] as const;
  // is_current and is_closed are excluded on purpose: they change through
  // setCurrent() and close(), which have their own rules and permissions.
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'start_date';
  protected readonly sortable: SortMap = {
    start_date: { column: 'academic_years.start_date', index: 'academic_years_pkey (small table)' },
    name: { column: 'academic_years.name', index: 'academic_years_pkey (small table)' },
  };

  async findCurrent(uow: Uow): Promise<AcademicYearRow | null> {
    return uow.maybeOne<AcademicYearRow>(
      `SELECT * FROM academic_years WHERE is_current LIMIT 1`,
    );
  }

  async listAll(uow: Uow): Promise<AcademicYearRow[]> {
    return uow.many<AcademicYearRow>(`SELECT * FROM academic_years ORDER BY start_date DESC`);
  }

  /**
   * Make one year current, atomically.
   *
   * Both statements in one transaction: clearing the old flag and setting the
   * new one must not be separable, or a crash between them leaves the school
   * with no current year and every request that needs one failing.
   */
  async setCurrent(uow: Uow, id: string): Promise<AcademicYearRow> {
    await uow.count(`UPDATE academic_years SET is_current = false WHERE is_current`);
    return uow.one<AcademicYearRow>(
      `UPDATE academic_years SET is_current = true WHERE id = $1 RETURNING *`,
      [id],
      'Academic year',
    );
  }

  async close(uow: Uow, id: string): Promise<AcademicYearRow> {
    return uow.one<AcademicYearRow>(
      `UPDATE academic_years SET is_closed = true WHERE id = $1 RETURNING *`,
      [id],
      'Academic year',
    );
  }

  /** Overlapping date ranges, excluding `excludeId` when editing. */
  async findOverlapping(
    uow: Uow,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<AcademicYearRow[]> {
    return uow.many<AcademicYearRow>(
      `SELECT * FROM academic_years
        WHERE daterange(start_date, end_date, '[]') && daterange($1::date, $2::date, '[]')
          AND ($3::bigint IS NULL OR id <> $3::bigint)`,
      [startDate, endDate, excludeId ?? null],
    );
  }

  /**
   * What is stopping this year from closing (Module 2).
   *
   * One query with filtered aggregates rather than several round trips, and it
   * returns counts rather than booleans so the message can say how much work
   * is outstanding.
   */
  async closingBlockers(
    uow: Uow,
    yearId: string,
  ): Promise<{
    unpaidInvoices: number;
    unpublishedReportCards: number;
    activeEnrollments: number;
    openExams: number;
  }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM fee_invoices i
            JOIN student_enrollments e ON e.id = i.enrollment_id
           WHERE e.academic_year_id = $1
             AND i.status IN ('unpaid','partial')) AS "unpaidInvoices",
         -- report_cards has no is_published flag; publication is recorded by
         -- published_at being set.
         (SELECT count(*)::int FROM report_cards rc
            JOIN exams ex ON ex.id = rc.exam_id
           WHERE ex.academic_year_id = $1 AND rc.published_at IS NULL) AS "unpublishedReportCards",
         (SELECT count(*)::int FROM student_enrollments e
           WHERE e.academic_year_id = $1 AND e.status = 'active') AS "activeEnrollments",
         (SELECT count(*)::int FROM exams ex
           WHERE ex.academic_year_id = $1 AND ex.status <> 'locked') AS "openExams"`,
      [yearId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Terms
 * ------------------------------------------------------------------ */

export type TermRow = BaseRow & {
  academic_year_id: string;
  name: string;
  start_date: string;
  end_date: string;
};

export class TermRepository extends BaseRepository<TermRow> {
  protected readonly table = 'terms';
  protected readonly writableColumns = ['academic_year_id', 'name', 'start_date', 'end_date'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'start_date';
  protected readonly sortable: SortMap = {
    start_date: { column: 'terms.start_date', index: 'terms_pkey (small table)' },
  };

  async listForYear(uow: Uow, yearId: string): Promise<TermRow[]> {
    return uow.many<TermRow>(
      `SELECT * FROM terms WHERE academic_year_id = $1 ORDER BY start_date`,
      [yearId],
    );
  }

  /** Terms in the same year whose range overlaps. */
  async findOverlapping(
    uow: Uow,
    yearId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<TermRow[]> {
    return uow.many<TermRow>(
      `SELECT * FROM terms
        WHERE academic_year_id = $1
          AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')
          AND ($4::bigint IS NULL OR id <> $4::bigint)`,
      [yearId, startDate, endDate, excludeId ?? null],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Classes
 * ------------------------------------------------------------------ */

export type ClassRow = SoftDeletableRow & { name: string; level_order: number };

export class ClassRepository extends BaseRepository<ClassRow> {
  protected readonly table = 'classes';
  protected readonly writableColumns = ['name', 'level_order'] as const;
  protected readonly defaultSort = 'level_order';
  protected readonly sortable: SortMap = {
    level_order: { column: 'classes.level_order', index: 'classes_pkey (small table)' },
    name: { column: 'classes.name', index: 'classes_pkey (small table)' },
  };

  async listAll(uow: Uow): Promise<ClassRow[]> {
    return uow.many<ClassRow>(
      `SELECT * FROM classes WHERE deleted_at IS NULL ORDER BY level_order, name`,
    );
  }

  /** Whether anything still references this class. Guards the soft delete. */
  async referenceCounts(uow: Uow, classId: string): Promise<{ sections: number; enrollments: number }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM sections s
           WHERE s.class_id = $1 AND s.deleted_at IS NULL)     AS sections,
         (SELECT count(*)::int FROM student_enrollments e
           WHERE e.class_id = $1)                              AS enrollments`,
      [classId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

export type SectionRow = SoftDeletableRow & {
  class_id: string;
  name: string;
  capacity: number;
  class_teacher_id: string | null;
};

export type SectionWithStrength = SectionRow & {
  class_name: string;
  strength: number;
  class_teacher_name: string | null;
};

export class SectionRepository extends BaseRepository<SectionRow> {
  protected readonly table = 'sections';
  protected readonly writableColumns = ['class_id', 'name', 'capacity', 'class_teacher_id'] as const;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = {
    name: { column: 'sections.name', index: 'sections_pkey (small table)' },
  };

  /**
   * Sections with their current strength against capacity (Module 2).
   *
   * Strength is counted for the current academic year only — a section's
   * occupancy means this year's, not the sum of every year it has ever had.
   */
  async listWithStrength(uow: Uow, classId?: string): Promise<SectionWithStrength[]> {
    return uow.many<SectionWithStrength>(
      `SELECT s.*,
              c.name AS class_name,
              st.full_name AS class_teacher_name,
              COALESCE(cnt.strength, 0)::int AS strength
         FROM sections s
         JOIN classes c ON c.id = s.class_id
    LEFT JOIN staff st ON st.id = s.class_teacher_id
    LEFT JOIN (
           SELECT e.section_id, count(*) AS strength
             FROM student_enrollments e
             JOIN academic_years ay ON ay.id = e.academic_year_id
            WHERE ay.is_current AND e.status = 'active'
            GROUP BY e.section_id
         ) cnt ON cnt.section_id = s.id
        WHERE s.deleted_at IS NULL
          AND ($1::bigint IS NULL OR s.class_id = $1::bigint)
        ORDER BY c.level_order, s.name`,
      [classId ?? null],
    );
  }

  /** Current-year active enrollment count, for the capacity check. */
  async currentStrength(uow: Uow, sectionId: string): Promise<number> {
    const row = await uow.one<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM student_enrollments e
         JOIN academic_years ay ON ay.id = e.academic_year_id
        WHERE e.section_id = $1 AND ay.is_current AND e.status = 'active'`,
      [sectionId],
    );
    return row.n;
  }

  /**
   * Lock a section row.
   *
   * Taken before assigning a roll number, so two concurrent enrolments into the
   * same section serialise instead of both reading the same "next" number
   * (Part 9.5).
   */
  async lockForEnrollment(uow: Uow, sectionId: string): Promise<SectionRow> {
    return uow.one<SectionRow>(
      `SELECT * FROM sections WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [sectionId],
      'Section',
    );
  }

  async belongsToClass(uow: Uow, sectionId: string, classId: string): Promise<boolean> {
    const row = await uow.maybeOne<{ ok: boolean }>(
      `SELECT true AS ok FROM sections
        WHERE id = $1 AND class_id = $2 AND deleted_at IS NULL`,
      [sectionId, classId],
    );
    return row !== null;
  }
}

/* ------------------------------------------------------------------ *
 * Subjects and mappings
 * ------------------------------------------------------------------ */

export type SubjectRow = SoftDeletableRow & { code: string; name: string; type: string };

export class SubjectRepository extends BaseRepository<SubjectRow> {
  protected readonly table = 'subjects';
  protected readonly writableColumns = ['code', 'name', 'type'] as const;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = {
    name: { column: 'subjects.name', index: 'subjects_pkey (small table)' },
    code: { column: 'subjects.code', index: 'subjects_code_key' },
  };

  async listAll(uow: Uow): Promise<SubjectRow[]> {
    return uow.many<SubjectRow>(
      `SELECT * FROM subjects WHERE deleted_at IS NULL ORDER BY name`,
    );
  }
}

export type ClassSubjectRow = BaseRow & {
  class_id: string;
  subject_id: string;
  is_mandatory: boolean;
};

export class ClassSubjectRepository extends BaseRepository<ClassSubjectRow> {
  protected readonly table = 'class_subjects';
  protected readonly writableColumns = ['class_id', 'subject_id', 'is_mandatory'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = {
    id: { column: 'class_subjects.id', index: 'class_subjects_pkey' },
  };

  async listForClass(
    uow: Uow,
    classId: string,
  ): Promise<(ClassSubjectRow & { subject_name: string; subject_code: string })[]> {
    return uow.many(
      `SELECT cs.*, s.name AS subject_name, s.code AS subject_code
         FROM class_subjects cs
         JOIN subjects s ON s.id = cs.subject_id
        WHERE cs.class_id = $1 AND s.deleted_at IS NULL
        ORDER BY s.name`,
      [classId],
    );
  }

  async isMapped(uow: Uow, classId: string, subjectId: string): Promise<boolean> {
    const row = await uow.maybeOne<{ ok: boolean }>(
      `SELECT true AS ok FROM class_subjects WHERE class_id = $1 AND subject_id = $2`,
      [classId, subjectId],
    );
    return row !== null;
  }

  /** Replace a class's subject list in one statement pair (set semantics). */
  async setForClass(
    uow: Uow,
    classId: string,
    entries: readonly { subjectId: string; isMandatory: boolean }[],
  ): Promise<number> {
    const ids = entries.map((e) => e.subjectId);

    await uow.count(
      `DELETE FROM class_subjects
        WHERE class_id = $1 AND NOT (subject_id = ANY($2::bigint[]))`,
      [classId, ids],
    );

    if (entries.length === 0) return 0;

    return uow.count(
      `INSERT INTO class_subjects (class_id, subject_id, is_mandatory)
       SELECT $1, * FROM unnest($2::bigint[], $3::boolean[])
       ON CONFLICT (class_id, subject_id) DO UPDATE SET is_mandatory = EXCLUDED.is_mandatory`,
      [classId, ids, entries.map((e) => e.isMandatory)],
    );
  }
}

export type SubjectTeacherRow = BaseRow & {
  academic_year_id: string;
  section_id: string;
  subject_id: string;
  staff_id: string;
};

export class SubjectTeacherRepository extends BaseRepository<SubjectTeacherRow> {
  protected readonly table = 'subject_teachers';
  protected readonly writableColumns = [
    'academic_year_id',
    'section_id',
    'subject_id',
    'staff_id',
  ] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = {
    id: { column: 'subject_teachers.id', index: 'subject_teachers_pkey' },
  };

  async listForYear(
    uow: Uow,
    yearId: string,
    filters: { sectionId?: string | undefined; staffId?: string | undefined } = {},
  ): Promise<
    (SubjectTeacherRow & {
      subject_name: string;
      section_name: string;
      class_name: string;
      staff_name: string;
    })[]
  > {
    return uow.many(
      `SELECT st.*,
              sub.name AS subject_name,
              sec.name AS section_name,
              c.name   AS class_name,
              s.full_name AS staff_name
         FROM subject_teachers st
         JOIN subjects sub ON sub.id = st.subject_id
         JOIN sections sec ON sec.id = st.section_id
         JOIN classes c    ON c.id = sec.class_id
         JOIN staff s      ON s.id = st.staff_id
        WHERE st.academic_year_id = $1
          AND ($2::bigint IS NULL OR st.section_id = $2::bigint)
          AND ($3::bigint IS NULL OR st.staff_id = $3::bigint)
        ORDER BY c.level_order, sec.name, sub.name`,
      [yearId, filters.sectionId ?? null, filters.staffId ?? null],
    );
  }

  /**
   * Clone a year's assignments into another year (Module 2, "copy setup").
   *
   * Set-based, and skips rows whose section or subject no longer exists so a
   * deleted section does not fail the whole copy.
   */
  async copyToYear(uow: Uow, fromYearId: string, toYearId: string): Promise<number> {
    return uow.count(
      `INSERT INTO subject_teachers (academic_year_id, section_id, subject_id, staff_id)
       SELECT $2, st.section_id, st.subject_id, st.staff_id
         FROM subject_teachers st
         JOIN sections sec ON sec.id = st.section_id AND sec.deleted_at IS NULL
         JOIN subjects sub ON sub.id = st.subject_id AND sub.deleted_at IS NULL
         JOIN staff s      ON s.id = st.staff_id AND s.deleted_at IS NULL AND s.status = 'active'
        WHERE st.academic_year_id = $1
       ON CONFLICT DO NOTHING`,
      [fromYearId, toYearId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Rooms
 * ------------------------------------------------------------------ */

/** `room_type` is NOT NULL in the schema, so it is required on create. */
export type RoomRow = BaseRow & { name: string; capacity: number | null; room_type: string };

export class RoomRepository extends BaseRepository<RoomRow> {
  protected readonly table = 'rooms';
  protected readonly writableColumns = ['name', 'capacity', 'room_type'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = {
    name: { column: 'rooms.name', index: 'rooms_pkey (small table)' },
  };

  async listAll(uow: Uow): Promise<RoomRow[]> {
    return uow.many<RoomRow>(`SELECT * FROM rooms ORDER BY name`);
  }
}

/** Shared guard: refuse writes into a closed year before the trigger does. */
export async function assertYearOpen(uow: Uow, yearId: string): Promise<void> {
  const row = await uow.maybeOne<{ is_closed: boolean; name: string }>(
    `SELECT is_closed, name FROM academic_years WHERE id = $1`,
    [yearId],
  );
  if (!row) throw new ConflictError('That academic year does not exist.', 'UNKNOWN_YEAR');
  if (row.is_closed) {
    throw new BusinessRuleError(
      `Academic year "${row.name}" is closed and is now read-only.`,
      'YEAR_CLOSED',
    );
  }
}
