/**
 * Staff and HR data access (Module 7): departments, designations, staff.
 *
 * `employee_no` is left out of `writableColumns` on purpose, the same way
 * `admission_no` is kept off `StudentRepository`: it comes from
 * `seq_employee_no` through the column's own DEFAULT, so the base `create()`
 * method already produces it correctly via `RETURNING *` without a bespoke
 * formatter. Students use a custom year-prefixed format instead of the
 * database's own default, which is why that module calls a sequence directly —
 * there is no such requirement here, so the simpler path is used.
 */

import { BaseRepository, type SoftDeletableRow, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder, type SortMap } from '../../core/db/query-builder';
import { BusinessRuleError } from '../../core/errors';
import { STAFF_NAME_EXPR, containsPattern, prefixPattern } from '../../core/search/search-expressions';

/* ------------------------------------------------------------------ *
 * Departments and designations
 * ------------------------------------------------------------------ */

export type DepartmentRow = BaseRow & { name: string };

export class DepartmentRepository extends BaseRepository<DepartmentRow> {
  protected readonly table = 'departments';
  protected readonly writableColumns = ['name'] as const;
  // No deleted_at column on this table: it is a small reference list, deleted
  // for real once nothing refers to it, same as a lookup table rather than an
  // operational record.
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = {
    name: { column: 'departments.name', index: 'departments_pkey (small table)' },
  };

  async listAll(uow: Uow): Promise<DepartmentRow[]> {
    return uow.many<DepartmentRow>(`SELECT * FROM departments ORDER BY name`);
  }

  /** What is still pointing at this department, so delete can refuse. */
  async referenceCounts(uow: Uow, id: string): Promise<{ staff: number; designations: number }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM staff WHERE department_id = $1 AND deleted_at IS NULL) AS staff,
         (SELECT count(*)::int FROM designations WHERE department_id = $1) AS designations`,
      [id],
    );
  }

  async hardDelete(uow: Uow, id: string): Promise<void> {
    const affected = await uow.count(`DELETE FROM departments WHERE id = $1`, [id]);
    if (affected === 0) throw new BusinessRuleError('Department not found.', 'NOT_FOUND');
  }
}

export type DesignationRow = BaseRow & { name: string; department_id: string | null };

export class DesignationRepository extends BaseRepository<DesignationRow> {
  protected readonly table = 'designations';
  protected readonly writableColumns = ['name', 'department_id'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = {
    name: { column: 'designations.name', index: 'designations_pkey (small table)' },
  };

  async listAll(uow: Uow): Promise<DesignationRow[]> {
    return uow.many<DesignationRow>(`SELECT * FROM designations ORDER BY name`);
  }

  async referenceCounts(uow: Uow, id: string): Promise<{ staff: number }> {
    return uow.one(
      `SELECT (SELECT count(*)::int FROM staff WHERE designation_id = $1 AND deleted_at IS NULL) AS staff`,
      [id],
    );
  }

  async hardDelete(uow: Uow, id: string): Promise<void> {
    const affected = await uow.count(`DELETE FROM designations WHERE id = $1`, [id]);
    if (affected === 0) throw new BusinessRuleError('Designation not found.', 'NOT_FOUND');
  }
}

/* ------------------------------------------------------------------ *
 * Staff
 * ------------------------------------------------------------------ */

export type StaffRow = SoftDeletableRow & {
  employee_no: string;
  full_name: string;
  gender: string;
  dob: string;
  national_id: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  department_id: string | null;
  designation_id: string | null;
  join_date: string;
  status: string;
  photo_path: string | null;
  separation_date: string | null;
  separation_reason: string | null;
};

export class StaffRepository extends BaseRepository<StaffRow> {
  protected readonly table = 'staff';
  protected readonly writableColumns = [
    'full_name',
    'gender',
    'dob',
    'national_id',
    'phone',
    'email',
    'address',
    'department_id',
    'designation_id',
    'join_date',
    'photo_path',
  ] as const;
  // employee_no comes from the sequence default, and status changes only
  // through deactivate(), which has its own rule about going backwards.
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = {
    created_at: { column: 'staff.created_at', index: 'staff_pkey' },
    employee_no: { column: 'staff.employee_no', index: 'staff_employee_no_key' },
    full_name: { column: 'staff.full_name', index: 'staff_name_prefix_idx' },
  };

  async setStatus(uow: Uow, id: string, status: string): Promise<void> {
    await uow.count(`UPDATE staff SET status = $2 WHERE id = $1`, [id, status]);
  }

  /** Resignation or termination: status plus the date and reason behind it. */
  async separate(
    uow: Uow,
    id: string,
    status: 'resigned' | 'terminated',
    separationDate: string,
    reason: string | null,
  ): Promise<void> {
    await uow.count(
      `UPDATE staff SET status = $2, separation_date = $3, separation_reason = $4 WHERE id = $1`,
      [id, status, separationDate, reason],
    );
  }

  async findByEmployeeNo(uow: Uow, employeeNo: string): Promise<StaffRow | null> {
    return uow.maybeOne<StaffRow>(
      `SELECT * FROM staff WHERE employee_no = $1 AND deleted_at IS NULL`,
      [employeeNo],
    );
  }

  async findByNationalId(uow: Uow, nationalId: string): Promise<StaffRow | null> {
    return uow.maybeOne<StaffRow>(
      `SELECT * FROM staff WHERE national_id = $1 AND deleted_at IS NULL`,
      [nationalId],
    );
  }

  async findByPhone(uow: Uow, phone: string): Promise<StaffRow[]> {
    return uow.many<StaffRow>(
      `SELECT * FROM staff WHERE phone = $1 AND deleted_at IS NULL ORDER BY full_name`,
      [phone],
    );
  }

  /** Name search using the trigram/prefix indexes (Part 9.1), mirroring students. */
  async searchByName(
    uow: Uow,
    term: string,
    options: { limit: number; prefixOnly?: boolean },
  ): Promise<Pick<StaffRow, 'id' | 'employee_no' | 'full_name' | 'status' | 'designation_id'>[]> {
    const pattern = options.prefixOnly ? prefixPattern(term) : containsPattern(term);
    return uow.many(
      `SELECT id, employee_no, full_name, status, designation_id
         FROM staff
        WHERE deleted_at IS NULL
          AND ${STAFF_NAME_EXPR} LIKE $1
        ORDER BY ${STAFF_NAME_EXPR}
        LIMIT $2`,
      [pattern, options.limit],
    );
  }

  /**
   * Filtered, keyset-paginated staff list (Part 5.5).
   *
   * Mirrors `StudentRepository.listFiltered`: the same cursor shape, the same
   * "narrow the query, don't filter afterwards" rule.
   */
  async listFiltered(
    uow: Uow,
    filters: {
      departmentId?: string | undefined;
      designationId?: string | undefined;
      status?: string | undefined;
      gender?: string | undefined;
    },
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<(StaffRow & { department_name: string | null; designation_name: string | null })[]> {
    const where = new ConditionBuilder();
    where.add('s.deleted_at IS NULL');
    where.addIf(filters.departmentId, 's.department_id = ?', filters.departmentId);
    where.addIf(filters.designationId, 's.designation_id = ?', filters.designationId);
    where.addIf(filters.status, 's.status = ?', filters.status);
    where.addIf(filters.gender, 's.gender = ?', filters.gender);

    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(s.created_at, s.id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }

    return uow.many(
      `SELECT s.*, d.name AS department_name, g.name AS designation_name
         FROM staff s
    LEFT JOIN departments d  ON d.id = s.department_id
    LEFT JOIN designations g ON g.id = s.designation_id
        ${where.where()}
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Whether anything still references this staff member (Module 7). */
  async historyCounts(
    uow: Uow,
    staffId: string,
  ): Promise<{ contracts: number; attendance: number; assignments: number; payslips: number }> {
    return uow.one(
      `SELECT
         (SELECT count(*)::int FROM staff_contracts WHERE staff_id = $1) AS contracts,
         (SELECT count(*)::int FROM staff_attendance WHERE staff_id = $1) AS attendance,
         (SELECT count(*)::int FROM subject_teachers WHERE staff_id = $1) +
         (SELECT count(*)::int FROM sections WHERE class_teacher_id = $1 AND deleted_at IS NULL) AS assignments,
         (SELECT count(*)::int FROM payslips WHERE staff_id = $1) AS payslips`,
      [staffId],
    );
  }
}
