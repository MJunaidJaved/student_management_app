/**
 * Exams, schedules, marks, grading and results (Module 6) data access.
 *
 * The schema's own guards do most of the enforcement: `guard_marks` rejects
 * a mark above its exam schedule's `total_marks` and blocks editing a locked
 * row or a locked exam; `grading_scale_ranges`'s EXCLUDE constraint refuses
 * an overlapping percent band; `marks_exam_schedule_id_enrollment_id_key` and
 * `report_cards_exam_id_enrollment_id_key` make a duplicate entry impossible
 * at the database level. This layer validates what the database cannot —
 * room/time conflicts between exam schedules, which have no EXCLUDE
 * constraint the way timetable_entries does.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';

/* ------------------------------------------------------------------ *
 * Exam types
 * ------------------------------------------------------------------ */

export type ExamTypeRow = BaseRow & { name: string; weightage: string | null };

export class ExamTypeRepository extends BaseRepository<ExamTypeRow> {
  protected readonly table = 'exam_types';
  protected readonly writableColumns = ['name', 'weightage'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'exam_types.name', index: 'exam_types_name_key' } };

  async listAll(uow: Uow): Promise<ExamTypeRow[]> {
    return uow.many<ExamTypeRow>(`SELECT * FROM exam_types ORDER BY name`);
  }
}

/* ------------------------------------------------------------------ *
 * Exams
 * ------------------------------------------------------------------ */

export type ExamRow = BaseRow & {
  academic_year_id: string;
  term_id: string | null;
  exam_type_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
};

export class ExamRepository extends BaseRepository<ExamRow> {
  protected readonly table = 'exams';
  protected readonly writableColumns = ['academic_year_id', 'term_id', 'exam_type_id', 'name', 'start_date', 'end_date', 'status'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'start_date';
  protected readonly sortable: SortMap = {
    start_date: { column: 'exams.start_date', index: 'exams_pkey' },
    created_at: { column: 'exams.created_at', index: 'exams_pkey' },
  };

  async listFiltered(uow: Uow, filters: { academicYearId?: string | undefined; termId?: string | undefined; status?: string | undefined }): Promise<ExamRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.academicYearId) { params.push(filters.academicYearId); where.push(`academic_year_id = $${params.length}`); }
    if (filters.termId) { params.push(filters.termId); where.push(`term_id = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return uow.many<ExamRow>(`SELECT * FROM exams ${clause} ORDER BY start_date DESC, id DESC`, params);
  }

  async setStatus(uow: Uow, id: string, status: string): Promise<ExamRow> {
    return uow.one<ExamRow>(`UPDATE exams SET status = $2 WHERE id = $1 RETURNING *`, [id, status], 'Exam');
  }
}

/* ------------------------------------------------------------------ *
 * Exam schedules
 * ------------------------------------------------------------------ */

export type ExamScheduleRow = BaseRow & {
  exam_id: string;
  class_id: string;
  subject_id: string;
  exam_date: string;
  start_time: string;
  end_time: string;
  room_id: string | null;
  total_marks: string;
  passing_marks: string;
};

export class ExamScheduleRepository extends BaseRepository<ExamScheduleRow> {
  protected readonly table = 'exam_schedules';
  protected readonly writableColumns = ['exam_id', 'class_id', 'subject_id', 'exam_date', 'start_time', 'end_time', 'room_id', 'total_marks', 'passing_marks'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'exam_date';
  protected readonly sortable: SortMap = {
    exam_date: { column: 'exam_schedules.exam_date', index: 'exam_schedules_pkey' },
  };

  async listForExam(uow: Uow, examId: string): Promise<(ExamScheduleRow & { subject_name: string; class_name: string })[]> {
    return uow.many(
      `SELECT es.*, sub.name AS subject_name, c.name AS class_name
         FROM exam_schedules es
         JOIN subjects sub ON sub.id = es.subject_id
         JOIN classes c ON c.id = es.class_id
        WHERE es.exam_id = $1
        ORDER BY es.exam_date, es.start_time`,
      [examId],
    );
  }

  async listFiltered(
    uow: Uow,
    filters: { classId?: string | undefined; subjectId?: string | undefined; roomId?: string | undefined; examDate?: string | undefined; academicYearId?: string | undefined },
  ): Promise<(ExamScheduleRow & { subject_name: string; class_name: string; exam_name: string })[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.classId) { params.push(filters.classId); where.push(`es.class_id = $${params.length}`); }
    if (filters.subjectId) { params.push(filters.subjectId); where.push(`es.subject_id = $${params.length}`); }
    if (filters.roomId) { params.push(filters.roomId); where.push(`es.room_id = $${params.length}`); }
    if (filters.examDate) { params.push(filters.examDate); where.push(`es.exam_date = $${params.length}`); }
    if (filters.academicYearId) { params.push(filters.academicYearId); where.push(`e.academic_year_id = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return uow.many(
      `SELECT es.*, sub.name AS subject_name, c.name AS class_name, e.name AS exam_name
         FROM exam_schedules es
         JOIN subjects sub ON sub.id = es.subject_id
         JOIN classes c ON c.id = es.class_id
         JOIN exams e ON e.id = es.exam_id
        ${clause}
        ORDER BY es.exam_date, es.start_time`,
      params,
    );
  }

  /**
   * Conflicts a schedule insert/update must be refused for: the same room
   * double-booked at an overlapping time, or the same class sitting two
   * papers at once. Neither is a database constraint — `exam_schedules` has
   * no EXCLUDE the way `timetable_entries` does — so this is the
   * authoritative check, run inside the same transaction as the write.
   */
  async findConflicts(
    uow: Uow,
    input: { examDate: string; startTime: string; endTime: string; roomId: string | null; classId: string },
    excludeId?: string,
  ): Promise<{ dimension: 'room' | 'class'; subjectName: string }[]> {
    const params: unknown[] = [input.examDate, input.startTime, input.endTime, input.classId];
    const excludeClause = excludeId ? (params.push(excludeId), `AND es.id <> $${params.length}`) : '';
    const roomParamIndex = input.roomId ? (params.push(input.roomId), params.length) : null;

    const rows = await uow.many<{ dimension: 'room' | 'class'; subject_name: string }>(
      `SELECT 'class' AS dimension, sub.name AS subject_name
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
        WHERE es.exam_date = $1 AND es.start_time < $3 AND es.end_time > $2
          AND es.class_id = $4 ${excludeClause}
        UNION ALL
        SELECT 'room' AS dimension, sub.name AS subject_name
         FROM exam_schedules es JOIN subjects sub ON sub.id = es.subject_id
        WHERE es.exam_date = $1 AND es.start_time < $3 AND es.end_time > $2
          AND es.room_id = ${roomParamIndex ? `$${roomParamIndex}` : 'NULL'} ${excludeClause}`,
      params,
    );
    return rows.map((r) => ({ dimension: r.dimension, subjectName: r.subject_name }));
  }
}

/* ------------------------------------------------------------------ *
 * Marks
 * ------------------------------------------------------------------ */

export type MarkRow = BaseRow & {
  exam_schedule_id: string;
  enrollment_id: string;
  marks_obtained: string | null;
  is_absent: boolean;
  entered_by: string | null;
  is_locked: boolean;
};

export class MarkRepository extends BaseRepository<MarkRow> {
  protected readonly table = 'marks';
  protected readonly writableColumns = ['exam_schedule_id', 'enrollment_id', 'marks_obtained', 'is_absent', 'entered_by', 'is_locked'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'marks.id', index: 'marks_pkey' } };

  /**
   * One bulk upsert per submission (Part 9.3), relying on the same unique
   * constraint `trg_guard_marks` already checks per row: a resubmission is a
   * correction, not a duplicate. `guard_marks` still runs for every row in
   * the batch — a locked schedule or a locked exam rejects the whole
   * statement, not just the offending row, which is the all-or-nothing
   * behaviour a bulk entry should have.
   */
  async bulkUpsert(
    uow: Uow,
    rows: readonly { exam_schedule_id: string; enrollment_id: string; marks_obtained: string | null; is_absent: boolean; entered_by: string }[],
  ): Promise<MarkRow[]> {
    if (rows.length === 0) return [];
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      params.push(r.exam_schedule_id, r.enrollment_id, r.marks_obtained, r.is_absent, r.entered_by);
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    return uow.many<MarkRow>(
      `INSERT INTO marks (exam_schedule_id, enrollment_id, marks_obtained, is_absent, entered_by)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (exam_schedule_id, enrollment_id) DO UPDATE
         SET marks_obtained = EXCLUDED.marks_obtained, is_absent = EXCLUDED.is_absent, entered_by = EXCLUDED.entered_by
       RETURNING *`,
      params,
    );
  }

  async forSchedule(uow: Uow, examScheduleId: string): Promise<(MarkRow & { first_name: string; last_name: string | null; roll_no: number })[]> {
    return uow.many(
      `SELECT m.*, s.first_name, s.last_name, e.roll_no
         FROM marks m
         JOIN student_enrollments e ON e.id = m.enrollment_id
         JOIN students s ON s.id = e.student_id
        WHERE m.exam_schedule_id = $1
        ORDER BY e.roll_no`,
      [examScheduleId],
    );
  }

  /** Every mark for one student across one exam's schedules, for result computation. */
  async forEnrollmentAndExam(uow: Uow, enrollmentId: string, examId: string): Promise<(MarkRow & { subject_id: string; subject_name: string; total_marks: string; passing_marks: string })[]> {
    return uow.many(
      `SELECT m.*, es.subject_id, sub.name AS subject_name, es.total_marks, es.passing_marks
         FROM marks m
         JOIN exam_schedules es ON es.id = m.exam_schedule_id
         JOIN subjects sub ON sub.id = es.subject_id
        WHERE m.enrollment_id = $1 AND es.exam_id = $2
        ORDER BY sub.name`,
      [enrollmentId, examId],
    );
  }

  async setLocked(uow: Uow, id: string, locked: boolean): Promise<MarkRow> {
    return uow.one<MarkRow>(`UPDATE marks SET is_locked = $2 WHERE id = $1 RETURNING *`, [id, locked], 'Mark');
  }
}

/* ------------------------------------------------------------------ *
 * Grading scales
 * ------------------------------------------------------------------ */

export type GradingScaleRow = BaseRow & { name: string; is_default: boolean };

export class GradingScaleRepository extends BaseRepository<GradingScaleRow> {
  protected readonly table = 'grading_scales';
  protected readonly writableColumns = ['name', 'is_default'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'grading_scales.name', index: 'grading_scales_name_key' } };

  async listAll(uow: Uow): Promise<GradingScaleRow[]> {
    return uow.many<GradingScaleRow>(`SELECT * FROM grading_scales ORDER BY name`);
  }

  async findDefault(uow: Uow): Promise<GradingScaleRow | null> {
    return uow.maybeOne<GradingScaleRow>(`SELECT * FROM grading_scales WHERE is_default LIMIT 1`);
  }

  /**
   * Clear every other scale's default flag before setting this one's — the
   * same two-step a single-row UNIQUE-WHERE index needs, done inside the
   * caller's transaction so the gap between clearing and setting is never
   * visible to another request.
   */
  async clearDefault(uow: Uow): Promise<void> {
    await uow.count(`UPDATE grading_scales SET is_default = false WHERE is_default`);
  }
}

export type GradingScaleRangeRow = BaseRow & {
  grading_scale_id: string;
  min_percent: string;
  max_percent: string;
  grade: string;
  gpa_points: string | null;
  remark: string | null;
};

export class GradingScaleRangeRepository extends BaseRepository<GradingScaleRangeRow> {
  protected readonly table = 'grading_scale_ranges';
  protected readonly writableColumns = ['grading_scale_id', 'min_percent', 'max_percent', 'grade', 'gpa_points', 'remark'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'min_percent';
  protected readonly sortable: SortMap = { min_percent: { column: 'grading_scale_ranges.min_percent', index: 'grading_scale_ranges_pkey' } };

  async listForScale(uow: Uow, scaleId: string): Promise<GradingScaleRangeRow[]> {
    return uow.many<GradingScaleRangeRow>(`SELECT * FROM grading_scale_ranges WHERE grading_scale_id = $1 ORDER BY min_percent DESC`, [scaleId]);
  }

  /** The one range a percentage falls into, if the scale covers it. */
  async findForPercentage(uow: Uow, scaleId: string, percent: string): Promise<GradingScaleRangeRow | null> {
    return uow.maybeOne<GradingScaleRangeRow>(
      `SELECT * FROM grading_scale_ranges WHERE grading_scale_id = $1 AND $2 BETWEEN min_percent AND max_percent LIMIT 1`,
      [scaleId, percent],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Report cards
 * ------------------------------------------------------------------ */

export type ReportCardRow = BaseRow & {
  exam_id: string;
  enrollment_id: string;
  total_marks: string;
  obtained_marks: string;
  percentage: string;
  grade: string | null;
  rank: number | null;
  remarks: string | null;
  published_at: string | null;
};

export class ReportCardRepository extends BaseRepository<ReportCardRow> {
  protected readonly table = 'report_cards';
  protected readonly writableColumns = ['exam_id', 'enrollment_id', 'total_marks', 'obtained_marks', 'percentage', 'grade', 'rank', 'remarks', 'published_at'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'report_cards.id', index: 'report_cards_pkey' } };

  async findForExamAndEnrollment(uow: Uow, examId: string, enrollmentId: string): Promise<ReportCardRow | null> {
    return uow.maybeOne<ReportCardRow>(`SELECT * FROM report_cards WHERE exam_id = $1 AND enrollment_id = $2`, [examId, enrollmentId]);
  }

  async listForExam(uow: Uow, examId: string): Promise<(ReportCardRow & { first_name: string; last_name: string | null; section_id: string; class_id: string; roll_no: number })[]> {
    return uow.many(
      `SELECT rc.*, s.first_name, s.last_name, e.section_id, e.class_id, e.roll_no
         FROM report_cards rc
         JOIN student_enrollments e ON e.id = rc.enrollment_id
         JOIN students s ON s.id = e.student_id
        WHERE rc.exam_id = $1
        ORDER BY e.roll_no`,
      [examId],
    );
  }

  async listForEnrollment(uow: Uow, enrollmentId: string): Promise<(ReportCardRow & { exam_name: string })[]> {
    return uow.many(
      `SELECT rc.*, e.name AS exam_name FROM report_cards rc JOIN exams e ON e.id = rc.exam_id
        WHERE rc.enrollment_id = $1 ORDER BY rc.created_at DESC`,
      [enrollmentId],
    );
  }

  /**
   * Insert-or-update by (exam_id, enrollment_id), relying on the same unique
   * constraint as `marks` — a re-publish recomputes in place rather than
   * accumulating a second row.
   */
  async upsert(uow: Uow, data: { exam_id: string; enrollment_id: string; total_marks: string; obtained_marks: string; percentage: string; grade: string | null; rank: number | null; published_at: string | null }): Promise<ReportCardRow> {
    return uow.one<ReportCardRow>(
      `INSERT INTO report_cards (exam_id, enrollment_id, total_marks, obtained_marks, percentage, grade, rank, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (exam_id, enrollment_id) DO UPDATE
         SET total_marks = EXCLUDED.total_marks, obtained_marks = EXCLUDED.obtained_marks,
             percentage = EXCLUDED.percentage, grade = EXCLUDED.grade, rank = EXCLUDED.rank,
             published_at = EXCLUDED.published_at
       RETURNING *`,
      [data.exam_id, data.enrollment_id, data.total_marks, data.obtained_marks, data.percentage, data.grade, data.rank, data.published_at],
    );
  }
}
