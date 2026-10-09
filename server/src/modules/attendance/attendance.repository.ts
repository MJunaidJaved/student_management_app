/**
 * Attendance data access (Module 4): student and staff.
 *
 * Both tables model daily attendance, one row per (person, date) — the
 * schema has no period/session column on either table, so a day is the unit,
 * not a class period. `UNIQUE (enrollment_id, att_date)` and
 * `UNIQUE (staff_id, att_date)` are what the bulk upserts below rely on:
 * submitting a whole section's sheet twice is a correction, not a duplicate.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder } from '../../core/db/query-builder';
import type { SortMap } from '../../core/db/query-builder';

/* ------------------------------------------------------------------ *
 * Student attendance
 * ------------------------------------------------------------------ */

export type StudentAttendanceRow = BaseRow & {
  enrollment_id: string;
  att_date: string;
  status: string;
  marked_by: string | null;
  remarks: string | null;
};

export class StudentAttendanceRepository extends BaseRepository<StudentAttendanceRow> {
  protected readonly table = 'student_attendance';
  protected readonly writableColumns = ['enrollment_id', 'att_date', 'status', 'marked_by', 'remarks'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'att_date';
  protected readonly sortable: SortMap = {
    att_date: { column: 'student_attendance.att_date', index: 'student_attendance_enrollment_id_att_date_key' },
  };

  /**
   * Submit a whole section's sheet in one bulk upsert (Part 9.3).
   *
   * One statement, not a loop: `check_allocation_total`-style triggers aside,
   * the real reason is that a class teacher submitting 40 rows one at a time
   * is 40 round trips for something that is one business action.
   */
  async bulkUpsert(
    uow: Uow,
    rows: readonly { enrollment_id: string; att_date: string; status: string; marked_by: string; remarks: string | null }[],
  ): Promise<StudentAttendanceRow[]> {
    if (rows.length === 0) return [];
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      params.push(r.enrollment_id, r.att_date, r.status, r.marked_by, r.remarks);
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    return uow.many<StudentAttendanceRow>(
      `INSERT INTO student_attendance (enrollment_id, att_date, status, marked_by, remarks)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (enrollment_id, att_date) DO UPDATE
         SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, remarks = EXCLUDED.remarks
       RETURNING *`,
      params,
    );
  }

  /** The section's roster for a date, with any existing attendance left-joined in. */
  async sheetForSection(
    uow: Uow,
    sectionId: string,
    yearId: string,
    date: string,
  ): Promise<
    {
      enrollment_id: string;
      roll_no: number;
      first_name: string;
      last_name: string | null;
      admission_no: string;
      status: string | null;
      remarks: string | null;
    }[]
  > {
    return uow.many(
      `SELECT e.id AS enrollment_id, e.roll_no, s.first_name, s.last_name, s.admission_no,
              a.status, a.remarks
         FROM student_enrollments e
         JOIN students s ON s.id = e.student_id
    LEFT JOIN student_attendance a ON a.enrollment_id = e.id AND a.att_date = $3
        WHERE e.section_id = $1 AND e.academic_year_id = $2 AND e.status = 'active' AND s.deleted_at IS NULL
        ORDER BY e.roll_no`,
      [sectionId, yearId, date],
    );
  }

  async forEnrollmentAndDate(uow: Uow, enrollmentId: string, date: string): Promise<StudentAttendanceRow | null> {
    return uow.maybeOne<StudentAttendanceRow>(
      `SELECT * FROM student_attendance WHERE enrollment_id = $1 AND att_date = $2`,
      [enrollmentId, date],
    );
  }

  /** History for one enrollment, optionally bounded by date range, newest first. */
  async listForEnrollment(
    uow: Uow,
    enrollmentId: string,
    range: { from?: string | undefined; to?: string | undefined },
    page: { limit: number; cursorDate?: string | undefined; cursorId?: string | undefined },
  ): Promise<StudentAttendanceRow[]> {
    const where = new ConditionBuilder();
    where.add('enrollment_id = ?', enrollmentId);
    where.addIf(range.from, 'att_date >= ?', range.from);
    where.addIf(range.to, 'att_date <= ?', range.to);
    if (page.cursorDate && page.cursorId) {
      where.add('(att_date, id) < (?::date, ?::bigint)', page.cursorDate, page.cursorId);
    }
    return uow.many<StudentAttendanceRow>(
      `SELECT * FROM student_attendance ${where.where()}
        ORDER BY att_date DESC, id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Attendance percentage and status breakdown for one enrollment over a range. */
  async summaryForEnrollment(
    uow: Uow,
    enrollmentId: string,
    range: { from: string; to: string },
  ): Promise<{ present: number; absent: number; late: number; leave: number; total: number }> {
    return uow.one(
      `SELECT
         count(*) FILTER (WHERE status = 'present')::int AS present,
         count(*) FILTER (WHERE status = 'absent')::int  AS absent,
         count(*) FILTER (WHERE status = 'late')::int    AS late,
         count(*) FILTER (WHERE status = 'leave')::int   AS leave,
         count(*)::int AS total
       FROM student_attendance
      WHERE enrollment_id = $1 AND att_date BETWEEN $2 AND $3`,
      [enrollmentId, range.from, range.to],
    );
  }

  /** Per-section daily counts (Part 9.3: set-based, not a loop over students). */
  async summaryForSection(
    uow: Uow,
    sectionId: string,
    yearId: string,
    date: string,
  ): Promise<{ present: number; absent: number; late: number; leave: number; unmarked: number; total: number }> {
    return uow.one(
      `SELECT
         count(*) FILTER (WHERE a.status = 'present')::int AS present,
         count(*) FILTER (WHERE a.status = 'absent')::int  AS absent,
         count(*) FILTER (WHERE a.status = 'late')::int    AS late,
         count(*) FILTER (WHERE a.status = 'leave')::int   AS leave,
         count(*) FILTER (WHERE a.status IS NULL)::int     AS unmarked,
         count(*)::int AS total
       FROM student_enrollments e
  LEFT JOIN student_attendance a ON a.enrollment_id = e.id AND a.att_date = $3
      WHERE e.section_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'`,
      [sectionId, yearId, date],
    );
  }

  /** Defaulter list: enrollments below a given attendance percentage over a range. */
  async defaultersForSection(
    uow: Uow,
    sectionId: string,
    yearId: string,
    range: { from: string; to: string },
    thresholdPercent: number,
  ): Promise<{ enrollment_id: string; first_name: string; last_name: string | null; present: number; total: number; percent: number }[]> {
    return uow.many(
      `SELECT e.id AS enrollment_id, s.first_name, s.last_name,
              count(a.*) FILTER (WHERE a.status = 'present')::int AS present,
              count(a.*)::int AS total,
              CASE WHEN count(a.*) = 0 THEN 0
                   ELSE round(100.0 * count(a.*) FILTER (WHERE a.status = 'present') / count(a.*), 1)
              END AS percent
         FROM student_enrollments e
         JOIN students s ON s.id = e.student_id
    LEFT JOIN student_attendance a ON a.enrollment_id = e.id AND a.att_date BETWEEN $3 AND $4
        WHERE e.section_id = $1 AND e.academic_year_id = $2 AND e.status = 'active'
        GROUP BY e.id, s.first_name, s.last_name
       HAVING count(a.*) = 0 OR 100.0 * count(a.*) FILTER (WHERE a.status = 'present') / count(a.*) < $5
        ORDER BY percent ASC`,
      [sectionId, yearId, range.from, range.to, thresholdPercent],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Staff attendance
 * ------------------------------------------------------------------ */

export type StaffAttendanceRow = BaseRow & {
  staff_id: string;
  att_date: string;
  check_in: string | null;
  check_out: string | null;
  status: string;
};

export class StaffAttendanceRepository extends BaseRepository<StaffAttendanceRow> {
  protected readonly table = 'staff_attendance';
  protected readonly writableColumns = ['staff_id', 'att_date', 'check_in', 'check_out', 'status'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'att_date';
  protected readonly sortable: SortMap = {
    att_date: { column: 'staff_attendance.att_date', index: 'staff_attendance_staff_id_att_date_key' },
  };

  async bulkUpsert(
    uow: Uow,
    rows: readonly { staff_id: string; att_date: string; status: string; check_in: string | null; check_out: string | null }[],
  ): Promise<StaffAttendanceRow[]> {
    if (rows.length === 0) return [];
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      params.push(r.staff_id, r.att_date, r.status, r.check_in, r.check_out);
      const n = params.length;
      return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    return uow.many<StaffAttendanceRow>(
      `INSERT INTO staff_attendance (staff_id, att_date, status, check_in, check_out)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (staff_id, att_date) DO UPDATE
         SET status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out
       RETURNING *`,
      params,
    );
  }

  async forStaffAndDate(uow: Uow, staffId: string, date: string): Promise<StaffAttendanceRow | null> {
    return uow.maybeOne<StaffAttendanceRow>(
      `SELECT * FROM staff_attendance WHERE staff_id = $1 AND att_date = $2`,
      [staffId, date],
    );
  }

  /** The daily roster: every active staff member, with any attendance for the date left-joined in. */
  async sheetForDate(
    uow: Uow,
    date: string,
    filters: { departmentId?: string | undefined; designationId?: string | undefined },
  ): Promise<
    { staff_id: string; full_name: string; employee_no: string; status: string | null; check_in: string | null; check_out: string | null }[]
  > {
    const where = new ConditionBuilder(1);
    where.add('s.deleted_at IS NULL');
    where.add("s.status = 'active'");
    where.addIf(filters.departmentId, 's.department_id = ?', filters.departmentId);
    where.addIf(filters.designationId, 's.designation_id = ?', filters.designationId);
    return uow.many(
      `SELECT s.id AS staff_id, s.full_name, s.employee_no, a.status, a.check_in, a.check_out
         FROM staff s
    LEFT JOIN staff_attendance a ON a.staff_id = s.id AND a.att_date = $1
        ${where.where()}
        ORDER BY s.full_name`,
      [date, ...where.params()],
    );
  }

  async listForStaff(
    uow: Uow,
    staffId: string,
    range: { from?: string | undefined; to?: string | undefined },
    page: { limit: number; cursorDate?: string | undefined; cursorId?: string | undefined },
  ): Promise<StaffAttendanceRow[]> {
    const where = new ConditionBuilder();
    where.add('staff_id = ?', staffId);
    where.addIf(range.from, 'att_date >= ?', range.from);
    where.addIf(range.to, 'att_date <= ?', range.to);
    if (page.cursorDate && page.cursorId) {
      where.add('(att_date, id) < (?::date, ?::bigint)', page.cursorDate, page.cursorId);
    }
    return uow.many<StaffAttendanceRow>(
      `SELECT * FROM staff_attendance ${where.where()}
        ORDER BY att_date DESC, id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Monthly summary feeding payroll (Module 8, days present/absent/late/half-day). */
  async summaryForStaff(
    uow: Uow,
    staffId: string,
    range: { from: string; to: string },
  ): Promise<{ present: number; absent: number; late: number; leave: number; halfDay: number; total: number }> {
    const row = await uow.one<{
      present: number; absent: number; late: number; leave: number; half_day: number; total: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'present')::int  AS present,
         count(*) FILTER (WHERE status = 'absent')::int   AS absent,
         count(*) FILTER (WHERE status = 'late')::int     AS late,
         count(*) FILTER (WHERE status = 'leave')::int    AS leave,
         count(*) FILTER (WHERE status = 'half_day')::int AS half_day,
         count(*)::int AS total
       FROM staff_attendance
      WHERE staff_id = $1 AND att_date BETWEEN $2 AND $3`,
      [staffId, range.from, range.to],
    );
    return { present: row.present, absent: row.absent, late: row.late, leave: row.leave, halfDay: row.half_day, total: row.total };
  }
}
