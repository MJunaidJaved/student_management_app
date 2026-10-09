/**
 * Leave data access (Module 4): leave types, leave requests, staff leave
 * balances.
 *
 * `leave_requests` models both student and staff leave in one table, exactly
 * one of `enrollment_id` / `staff_id` set per the CHECK constraint, which is
 * why both repositories below branch on `applicantType` rather than being
 * split into two tables the schema does not have.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder } from '../../core/db/query-builder';
import type { SortMap } from '../../core/db/query-builder';
import { BusinessRuleError } from '../../core/errors';

/* ------------------------------------------------------------------ *
 * Leave types
 * ------------------------------------------------------------------ */

export type LeaveTypeRow = BaseRow & { name: string; applies_to: string; days_per_year: number | null };

export class LeaveTypeRepository extends BaseRepository<LeaveTypeRow> {
  protected readonly table = 'leave_types';
  protected readonly writableColumns = ['name', 'applies_to', 'days_per_year'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'leave_types.name', index: 'leave_types_pkey (small table)' } };

  async listAll(uow: Uow): Promise<LeaveTypeRow[]> {
    return uow.many<LeaveTypeRow>(`SELECT * FROM leave_types ORDER BY name`);
  }

  async referenceCounts(uow: Uow, id: string): Promise<{ requests: number; balances: number }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM leave_requests WHERE leave_type_id = $1) AS requests,
         (SELECT count(*)::int FROM staff_leave_balances WHERE leave_type_id = $1) AS balances`,
      [id],
    );
  }

  async hardDelete(uow: Uow, id: string): Promise<void> {
    const affected = await uow.count(`DELETE FROM leave_types WHERE id = $1`, [id]);
    if (affected === 0) throw new BusinessRuleError('Leave type not found.', 'NOT_FOUND');
  }
}

/* ------------------------------------------------------------------ *
 * Leave requests
 * ------------------------------------------------------------------ */

export type LeaveRequestRow = BaseRow & {
  applicant_type: string;
  enrollment_id: string | null;
  staff_id: string | null;
  leave_type_id: string;
  from_date: string;
  to_date: string;
  reason: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
};

export class LeaveRequestRepository extends BaseRepository<LeaveRequestRow> {
  protected readonly table = 'leave_requests';
  protected readonly writableColumns = [
    'applicant_type',
    'enrollment_id',
    'staff_id',
    'leave_type_id',
    'from_date',
    'to_date',
    'reason',
  ] as const;
  // status/decided_by/decided_at change only through decide()/cancel() below.
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'leave_requests.created_at', index: 'leave_requests_pkey' } };

  /**
   * Overlapping pending-or-approved requests for the same person.
   *
   * The rule (documented here because the schema does not state one): two
   * leave requests for the same enrollment or the same staff member conflict
   * when their date ranges intersect at all, `[from, to]` inclusive on both
   * sides, and the existing one is still live (`pending` or `approved`) — a
   * `rejected` or `cancelled` request never blocks a new one.
   */
  async findOverlapping(
    uow: Uow,
    applicantType: 'student' | 'staff',
    personId: string,
    fromDate: string,
    toDate: string,
    excludeId?: string,
  ): Promise<LeaveRequestRow[]> {
    const column = applicantType === 'student' ? 'enrollment_id' : 'staff_id';
    return uow.many<LeaveRequestRow>(
      `SELECT * FROM leave_requests
        WHERE ${column} = $1
          AND status IN ('pending', 'approved')
          AND from_date <= $3 AND to_date >= $2
          AND ($4::bigint IS NULL OR id <> $4::bigint)`,
      [personId, fromDate, toDate, excludeId ?? null],
    );
  }

  async decide(uow: Uow, id: string, status: 'approved' | 'rejected' | 'cancelled', decidedBy: string | null): Promise<LeaveRequestRow> {
    return uow.one<LeaveRequestRow>(
      `UPDATE leave_requests
          SET status = $2, decided_by = $3, decided_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, status, decidedBy],
      'Leave request',
    );
  }

  async listFiltered(
    uow: Uow,
    filters: {
      applicantType?: string | undefined;
      status?: string | undefined;
      staffId?: string | undefined;
      enrollmentId?: string | undefined;
      enrollmentIds?: readonly string[] | undefined;
      sectionIdsForPendingStudent?: readonly string[] | undefined;
    },
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<(LeaveRequestRow & { section_id: string | null })[]> {
    const where = new ConditionBuilder();
    where.addIf(filters.applicantType, 'lr.applicant_type = ?', filters.applicantType);
    where.addIf(filters.status, 'lr.status = ?', filters.status);
    where.addIf(filters.staffId, 'lr.staff_id = ?', filters.staffId);
    where.addIf(filters.enrollmentId, 'lr.enrollment_id = ?', filters.enrollmentId);
    if (filters.enrollmentIds) {
      where.add('lr.enrollment_id = ANY(?)', filters.enrollmentIds);
    }
    if (filters.sectionIdsForPendingStudent) {
      where.add(
        "(lr.applicant_type = 'staff' OR (lr.applicant_type = 'student' AND e.section_id = ANY(?)))",
        filters.sectionIdsForPendingStudent,
      );
    }
    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(lr.created_at, lr.id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }
    return uow.many(
      `SELECT lr.*, e.section_id
         FROM leave_requests lr
    LEFT JOIN student_enrollments e ON e.id = lr.enrollment_id
        ${where.where()}
        ORDER BY lr.created_at DESC, lr.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Staff leave balances
 * ------------------------------------------------------------------ */

export type StaffLeaveBalanceRow = BaseRow & {
  staff_id: string;
  leave_type_id: string;
  academic_year_id: string;
  allotted: string;
  used: string;
};

export class StaffLeaveBalanceRepository extends BaseRepository<StaffLeaveBalanceRow> {
  protected readonly table = 'staff_leave_balances';
  protected readonly writableColumns = ['staff_id', 'leave_type_id', 'academic_year_id', 'allotted'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'staff_leave_balances.created_at', index: 'staff_leave_balances_pkey' } };

  async upsert(uow: Uow, staffId: string, leaveTypeId: string, academicYearId: string, allotted: number): Promise<StaffLeaveBalanceRow> {
    return uow.one<StaffLeaveBalanceRow>(
      `INSERT INTO staff_leave_balances (staff_id, leave_type_id, academic_year_id, allotted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (staff_id, leave_type_id, academic_year_id) DO UPDATE SET allotted = EXCLUDED.allotted
       RETURNING *`,
      [staffId, leaveTypeId, academicYearId, allotted],
    );
  }

  /** Locked so two simultaneous approvals cannot both pass the same insufficient-balance check (Part 9.5). */
  async lockForStaffTypeYear(
    uow: Uow,
    staffId: string,
    leaveTypeId: string,
    academicYearId: string,
  ): Promise<StaffLeaveBalanceRow | null> {
    return uow.maybeOne<StaffLeaveBalanceRow>(
      `SELECT * FROM staff_leave_balances
        WHERE staff_id = $1 AND leave_type_id = $2 AND academic_year_id = $3
        FOR UPDATE`,
      [staffId, leaveTypeId, academicYearId],
    );
  }

  async adjustUsed(uow: Uow, id: string, deltaDays: number): Promise<void> {
    await uow.count(`UPDATE staff_leave_balances SET used = used + $2 WHERE id = $1`, [id, deltaDays]);
  }

  async forStaff(uow: Uow, staffId: string, academicYearId?: string): Promise<(StaffLeaveBalanceRow & { leave_type_name: string })[]> {
    const where = new ConditionBuilder();
    where.add('b.staff_id = ?', staffId);
    where.addIf(academicYearId, 'b.academic_year_id = ?', academicYearId);
    return uow.many(
      `SELECT b.*, lt.name AS leave_type_name
         FROM staff_leave_balances b
         JOIN leave_types lt ON lt.id = b.leave_type_id
        ${where.where()}
        ORDER BY lt.name`,
      where.params(),
    );
  }
}
