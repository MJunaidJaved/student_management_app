/**
 * Attendance (Module 4): student and staff.
 *
 * Daily, not per-period: `student_attendance` and `staff_attendance` have no
 * period column, each is one row per (person, date), so "a day is late" or
 * "a day is present" is the only granularity the schema supports. That
 * decision was already made by the schema; this module follows it rather
 * than inventing a session concept the database has no column for.
 *
 * "No attendance on non-school days" is enforced as Saturday/Sunday are not
 * school days — the simplest rule the existing schema actually supports.
 * There is no holiday-calendar table or settings key for a custom list of
 * closures, and inventing one is a schema/settings decision outside this
 * module's mandate, so it is documented here rather than built silently.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { enforce, type PolicyContext, type SectionPolicy, type StudentPolicy } from '../../core/policy/policy';
import type { PermissionService } from '../../core/authz/permission-service';
import type { SettingsService } from '../settings/settings.service';
import type { SectionRepository } from '../academic/academic.repository';
import { EnrollmentRepository } from '../students/students.repository';
import { StaffRepository } from '../staff/staff.repository';
import {
  StudentAttendanceRepository,
  StaffAttendanceRepository,
  type StudentAttendanceRow,
  type StaffAttendanceRow,
} from './attendance.repository';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Weekend days come from the `attendance.weekend_days` setting (a comma list
 * of day names), so a school on a six-day week — Sunday off, as most schools in
 * Pakistan are — can take attendance on Saturday.
 */
function isSchoolDay(isoDate: string, weekendDays: string): boolean {
  const day = DAY_NAMES[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]!;
  const weekend = weekendDays.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return !weekend.includes(day);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export type StudentAttendanceView = {
  id: string;
  enrollmentId: string;
  attDate: string;
  status: string;
  markedBy: string | null;
  remarks: string | null;
};

function toStudentAttendanceView(row: StudentAttendanceRow): StudentAttendanceView {
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    attDate: row.att_date,
    status: row.status,
    markedBy: row.marked_by,
    remarks: row.remarks,
  };
}

export type StaffAttendanceView = {
  id: string;
  staffId: string;
  attDate: string;
  checkIn: string | null;
  checkOut: string | null;
  status: string;
};

function toStaffAttendanceView(row: StaffAttendanceRow): StaffAttendanceView {
  return { id: row.id, staffId: row.staff_id, attDate: row.att_date, checkIn: row.check_in, checkOut: row.check_out, status: row.status };
}

export class AttendanceService {
  constructor(
    private readonly studentAttendance: StudentAttendanceRepository,
    private readonly staffAttendance: StaffAttendanceRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly sections: SectionRepository,
    private readonly staff: StaffRepository,
    private readonly sectionPolicy: SectionPolicy,
    private readonly studentPolicy: StudentPolicy,
    private readonly permissions: PermissionService,
    private readonly settings: SettingsService,
  ) {}

  private async context(uow: Uow, actor: Actor): Promise<PolicyContext> {
    const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    return { actor, uow, permissions };
  }

  private async assertSchoolDay(date: string): Promise<void> {
    if (!isSchoolDay(date, await this.settings.get('attendance.weekend_days'))) {
      throw new BusinessRuleError(`${date} is a weekend; attendance is not taken on non-school days.`, 'NOT_A_SCHOOL_DAY');
    }
  }

  /** Past-date edits need the override permission and a written reason (Module 4). */
  private assertDateEditable(ctx: PolicyContext, date: string, reason: string | undefined): void {
    if (date > todayIso()) {
      throw new ValidationError('Attendance cannot be recorded for a future date.', [
        { field: 'date', message: 'Must not be after today.' },
      ]);
    }
    if (date < todayIso()) {
      if (!ctx.permissions.has('attendance.edit_past') && !ctx.permissions.has('attendance.mark_override') && ctx.actor.userType !== 'admin') {
        throw new ForbiddenError('Editing attendance for a past date requires the edit-past permission.');
      }
      if (!reason?.trim()) {
        throw new ValidationError('Editing a past date requires a reason.', [
          { field: 'reason', message: 'Required when the date is not today.' },
        ]);
      }
    }
  }

  /* ---------------- student attendance ---------------- */

  async getStudentSheet(actor: Actor, sectionId: string, yearId: string, date: string) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.sectionPolicy.canView(ctx, sectionId), 'Section');
      const rows = await this.studentAttendance.sheetForSection(uow, sectionId, yearId, date);
      return rows.map((r) => ({
        enrollmentId: r.enrollment_id,
        rollNo: r.roll_no,
        firstName: r.first_name,
        lastName: r.last_name,
        admissionNo: r.admission_no,
        status: r.status,
        remarks: r.remarks,
      }));
    });
  }

  /**
   * Submit a whole section's sheet in one bulk upsert.
   *
   * Validated entirely before anything is written: every enrollment id is
   * checked against this section and year first, and if even one is wrong
   * the whole call throws and nothing is written — a partially bad batch
   * never produces a partially written result.
   */
  async submitStudentSheet(
    actor: Actor,
    input: {
      sectionId: string;
      academicYearId: string;
      date: string;
      reason?: string | undefined;
      entries: { enrollmentId: string; status: string; remarks?: string | undefined }[];
    },
  ): Promise<{ saved: number }> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.sectionPolicy.canMarkAttendance(ctx, input.sectionId), 'Section');
      await this.assertSchoolDay(input.date);
      this.assertDateEditable(ctx, input.date, input.reason);

      if (input.entries.length === 0) {
        throw new ValidationError('At least one entry is required.', [{ field: 'entries', message: 'Must not be empty.' }]);
      }

      // Every submitted enrollment must actually belong to this section and
      // year and be active — never trust an id the client sent (Part 7.2).
      const valid = await uow.many<{ id: string }>(
        `SELECT id::text AS id FROM student_enrollments
          WHERE section_id = $1 AND academic_year_id = $2 AND status = 'active'
            AND id = ANY($3)`,
        [input.sectionId, input.academicYearId, input.entries.map((e) => e.enrollmentId)],
      );
      const validIds = new Set(valid.map((v) => v.id));
      const bad = input.entries.filter((e) => !validIds.has(e.enrollmentId));
      if (bad.length > 0) {
        throw new BusinessRuleError(
          `${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} reference an enrollment outside this section, year, or no longer active: ` +
            bad.map((b) => b.enrollmentId).join(', '),
          'INVALID_ENROLLMENT_IN_BATCH',
        );
      }

      const rows = await this.studentAttendance.bulkUpsert(
        uow,
        input.entries.map((e) => ({
          enrollment_id: e.enrollmentId,
          att_date: input.date,
          status: e.status,
          marked_by: String(actor.userId),
          remarks: e.remarks ?? null,
        })),
      );
      return { saved: rows.length };
    });
  }

  async getEnrollmentHistory(
    actor: Actor,
    enrollmentId: string,
    range: { from?: string | undefined; to?: string | undefined },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: StudentAttendanceView[]; nextCursor: string | null; hasMore: boolean }> {
    return readTransaction(actor, async (uow) => {
      const enrollment = await this.enrollments.getById(uow, enrollmentId);
      const ctx = await this.context(uow, actor);
      enforce(await this.studentPolicy.canView(ctx, enrollment.student_id), 'Student');

      let cursorDate: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorDate = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.studentAttendance.listForEnrollment(uow, enrollmentId, range, { limit: page.limit, cursorDate, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map(toStudentAttendanceView),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.att_date, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }

  async getStudentSummary(actor: Actor, enrollmentId: string, range: { from: string; to: string }) {
    return readTransaction(actor, async (uow) => {
      const enrollment = await this.enrollments.getById(uow, enrollmentId);
      const ctx = await this.context(uow, actor);
      enforce(await this.studentPolicy.canView(ctx, enrollment.student_id), 'Student');
      const summary = await this.studentAttendance.summaryForEnrollment(uow, enrollmentId, range);
      return {
        ...summary,
        percent: summary.total === 0 ? null : Math.round((1000 * summary.present) / summary.total) / 10,
      };
    });
  }

  async getSectionSummary(actor: Actor, sectionId: string, yearId: string, date: string) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.sectionPolicy.canView(ctx, sectionId), 'Section');
      return this.studentAttendance.summaryForSection(uow, sectionId, yearId, date);
    });
  }

  async getDefaulters(
    actor: Actor,
    sectionId: string,
    yearId: string,
    range: { from: string; to: string },
    thresholdPercent: number,
  ) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      enforce(await this.sectionPolicy.canView(ctx, sectionId), 'Section');
      const rows = await this.studentAttendance.defaultersForSection(uow, sectionId, yearId, range, thresholdPercent);
      return rows.map((r) => ({
        enrollmentId: r.enrollment_id,
        firstName: r.first_name,
        lastName: r.last_name,
        present: r.present,
        total: r.total,
        percent: r.percent,
      }));
    });
  }

  /* ---------------- staff attendance ---------------- */

  private async assertCanViewStaffAttendance(ctx: PolicyContext, staffId: string): Promise<void> {
    if (ctx.actor.userType === 'admin' || ctx.permissions.has('attendance.read_staff')) return;
    if (String(ctx.actor.staffId) === staffId) return;
    throw new NotFoundError('Staff');
  }

  async getStaffSheet(actor: Actor, date: string, filters: { departmentId?: string | undefined; designationId?: string | undefined }) {
    return readTransaction(actor, async (uow) =>
      (await this.staffAttendance.sheetForDate(uow, date, filters)).map((r) => ({
        staffId: r.staff_id,
        fullName: r.full_name,
        employeeNo: r.employee_no,
        status: r.status,
        checkIn: r.check_in,
        checkOut: r.check_out,
      })),
    );
  }

  async submitStaffSheet(
    actor: Actor,
    input: {
      date: string;
      reason?: string | undefined;
      entries: { staffId: string; status: string; checkIn?: string | undefined; checkOut?: string | undefined }[];
    },
  ): Promise<{ saved: number }> {
    return transaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      await this.assertSchoolDay(input.date);
      this.assertDateEditable(ctx, input.date, input.reason);

      if (input.entries.length === 0) {
        throw new ValidationError('At least one entry is required.', [{ field: 'entries', message: 'Must not be empty.' }]);
      }
      for (const e of input.entries) {
        if (e.checkIn && e.checkOut && e.checkOut <= e.checkIn) {
          throw new ValidationError(`Check-out must be after check-in for staff ${e.staffId}.`, [
            { field: 'checkOut', message: 'Must be after checkIn.' },
          ]);
        }
      }

      // Only currently-active staff may receive a new attendance record —
      // a resigned or terminated staff member is not "currently active"
      // even if the row would otherwise be well-formed.
      const active = await uow.many<{ id: string }>(
        `SELECT id::text AS id FROM staff WHERE deleted_at IS NULL AND status = 'active' AND id = ANY($1)`,
        [input.entries.map((e) => e.staffId)],
      );
      const activeIds = new Set(active.map((a) => a.id));
      const bad = input.entries.filter((e) => !activeIds.has(e.staffId));
      if (bad.length > 0) {
        throw new BusinessRuleError(
          `${bad.length} staff id(s) are not currently active: ${bad.map((b) => b.staffId).join(', ')}`,
          'STAFF_NOT_ACTIVE',
        );
      }

      const rows = await this.staffAttendance.bulkUpsert(
        uow,
        input.entries.map((e) => ({
          staff_id: e.staffId,
          att_date: input.date,
          status: e.status,
          check_in: e.checkIn ?? null,
          check_out: e.checkOut ?? null,
        })),
      );
      return { saved: rows.length };
    });
  }

  async getStaffHistory(
    actor: Actor,
    staffId: string,
    range: { from?: string | undefined; to?: string | undefined },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: StaffAttendanceView[]; nextCursor: string | null; hasMore: boolean }> {
    return readTransaction(actor, async (uow) => {
      await this.staff.getById(uow, staffId);
      const ctx = await this.context(uow, actor);
      await this.assertCanViewStaffAttendance(ctx, staffId);

      let cursorDate: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorDate = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.staffAttendance.listForStaff(uow, staffId, range, { limit: page.limit, cursorDate, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map(toStaffAttendanceView),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.att_date, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }

  async getStaffSummary(actor: Actor, staffId: string, range: { from: string; to: string }) {
    return readTransaction(actor, async (uow) => {
      await this.staff.getById(uow, staffId);
      const ctx = await this.context(uow, actor);
      await this.assertCanViewStaffAttendance(ctx, staffId);
      return this.staffAttendance.summaryForStaff(uow, staffId, range);
    });
  }
}
