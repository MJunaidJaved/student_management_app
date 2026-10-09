/**
 * Payroll (Module 8) data access.
 *
 * `staff_salaries_staff_id_daterange_excl` (EXCLUDE USING gist) is the
 * database's own guarantee that one staff member never has two overlapping
 * effective salary assignments — the same guarantee Section 3 relied on for
 * `grading_scale_ranges`. `payroll_runs_pay_month_pay_year_key` (UNIQUE)
 * guarantees one run per period, and `payslips_payroll_run_id_staff_id_key`
 * guarantees one payslip per staff member per run. `guard_payslips` makes a
 * payslip (and, after migration 012, its line items) immutable once its run
 * leaves `draft` — see payroll.service.ts's header for what that means for
 * `paid_on`.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';

/* ------------------------------------------------------------------ *
 * Salary components and structures
 * ------------------------------------------------------------------ */

export type SalaryComponentRow = BaseRow & { name: string; type: string; calc_type: string };

export class SalaryComponentRepository extends BaseRepository<SalaryComponentRow> {
  protected readonly table = 'salary_components';
  protected readonly writableColumns = ['name', 'type', 'calc_type'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'salary_components.name', index: 'salary_components_name_key' } };

  async listAll(uow: Uow): Promise<SalaryComponentRow[]> {
    return uow.many<SalaryComponentRow>(`SELECT * FROM salary_components ORDER BY name`);
  }
}

export type SalaryStructureRow = BaseRow & { name: string; description: string | null };

export class SalaryStructureRepository extends BaseRepository<SalaryStructureRow> {
  protected readonly table = 'salary_structures';
  protected readonly writableColumns = ['name', 'description'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'salary_structures.name', index: 'salary_structures_name_key' } };

  async listAll(uow: Uow): Promise<SalaryStructureRow[]> {
    return uow.many<SalaryStructureRow>(`SELECT * FROM salary_structures ORDER BY name`);
  }
}

/* ------------------------------------------------------------------ *
 * Staff salaries (effective-dated)
 * ------------------------------------------------------------------ */

export type StaffSalaryRow = BaseRow & {
  staff_id: string;
  salary_structure_id: string | null;
  basic_salary: string;
  effective_from: string;
  effective_to: string | null;
};

export class StaffSalaryRepository extends BaseRepository<StaffSalaryRow> {
  protected readonly table = 'staff_salaries';
  protected readonly writableColumns = ['staff_id', 'salary_structure_id', 'basic_salary', 'effective_from', 'effective_to'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'effective_from';
  protected readonly sortable: SortMap = { effective_from: { column: 'staff_salaries.effective_from', index: 'staff_salaries_pkey' } };

  async listForStaff(uow: Uow, staffId: string): Promise<StaffSalaryRow[]> {
    return uow.many<StaffSalaryRow>(`SELECT * FROM staff_salaries WHERE staff_id = $1 ORDER BY effective_from DESC`, [staffId]);
  }

  /** The one still-open assignment, if any — closed before a new one starts, never left to overlap. */
  async findOpen(uow: Uow, staffId: string): Promise<StaffSalaryRow | null> {
    return uow.maybeOne<StaffSalaryRow>(`SELECT * FROM staff_salaries WHERE staff_id = $1 AND effective_to IS NULL`, [staffId]);
  }

  /** The assignment effective on a given date — at most one, guaranteed by the EXCLUDE constraint. */
  async findEffectiveOn(uow: Uow, staffId: string, date: string): Promise<StaffSalaryRow | null> {
    return uow.maybeOne<StaffSalaryRow>(
      `SELECT * FROM staff_salaries WHERE staff_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`,
      [staffId, date],
    );
  }

  async close(uow: Uow, id: string, effectiveTo: string): Promise<void> {
    await uow.count(`UPDATE staff_salaries SET effective_to = $2 WHERE id = $1`, [id, effectiveTo]);
  }
}

/* ------------------------------------------------------------------ *
 * Payroll runs
 * ------------------------------------------------------------------ */

export type PayrollRunRow = BaseRow & {
  pay_month: number;
  pay_year: number;
  status: string;
  run_by: string | null;
  approved_by: string | null;
};

export class PayrollRunRepository extends BaseRepository<PayrollRunRow> {
  protected readonly table = 'payroll_runs';
  protected readonly writableColumns = ['pay_month', 'pay_year', 'status', 'run_by', 'approved_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = {
    id: { column: 'payroll_runs.id', index: 'payroll_runs_pkey' },
  };

  async findByPeriod(uow: Uow, payMonth: number, payYear: number): Promise<PayrollRunRow | null> {
    return uow.maybeOne<PayrollRunRow>(`SELECT * FROM payroll_runs WHERE pay_month = $1 AND pay_year = $2`, [payMonth, payYear]);
  }

  async listFiltered(uow: Uow, filters: { payYear?: number | undefined; status?: string | undefined }): Promise<PayrollRunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.payYear !== undefined) { params.push(filters.payYear); where.push(`pay_year = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return uow.many<PayrollRunRow>(`SELECT * FROM payroll_runs ${clause} ORDER BY pay_year DESC, pay_month DESC`, params);
  }

  async setStatus(uow: Uow, id: string, status: string, extra: { approvedBy?: string | undefined } = {}): Promise<PayrollRunRow> {
    if (extra.approvedBy !== undefined) {
      return uow.one<PayrollRunRow>(`UPDATE payroll_runs SET status = $2, approved_by = $3 WHERE id = $1 RETURNING *`, [id, status, extra.approvedBy], 'Payroll run');
    }
    return uow.one<PayrollRunRow>(`UPDATE payroll_runs SET status = $2 WHERE id = $1 RETURNING *`, [id, status], 'Payroll run');
  }
}

/* ------------------------------------------------------------------ *
 * Payslips and their line items
 * ------------------------------------------------------------------ */

export type PayslipRow = BaseRow & {
  payroll_run_id: string;
  staff_id: string;
  gross: string;
  total_deductions: string;
  net: string;
  paid_on: string | null;
};

export class PayslipRepository extends BaseRepository<PayslipRow> {
  protected readonly table = 'payslips';
  protected readonly writableColumns = ['payroll_run_id', 'staff_id', 'gross', 'total_deductions', 'net', 'paid_on'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'payslips.id', index: 'payslips_pkey' } };

  async findForRunAndStaff(uow: Uow, payrollRunId: string, staffId: string): Promise<PayslipRow | null> {
    return uow.maybeOne<PayslipRow>(`SELECT * FROM payslips WHERE payroll_run_id = $1 AND staff_id = $2`, [payrollRunId, staffId]);
  }

  async listForRun(uow: Uow, payrollRunId: string): Promise<(PayslipRow & { full_name: string; employee_no: string })[]> {
    return uow.many(
      `SELECT p.*, s.full_name, s.employee_no FROM payslips p JOIN staff s ON s.id = p.staff_id
        WHERE p.payroll_run_id = $1 ORDER BY s.full_name`,
      [payrollRunId],
    );
  }

  async listForStaff(uow: Uow, staffId: string): Promise<(PayslipRow & { pay_month: number; pay_year: number; run_status: string })[]> {
    return uow.many(
      `SELECT p.*, r.pay_month, r.pay_year, r.status AS run_status FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
        WHERE p.staff_id = $1 ORDER BY r.pay_year DESC, r.pay_month DESC`,
      [staffId],
    );
  }

  /** The only legal post-creation write while the run is still draft — see guard_payslips. */
  async updateTotals(uow: Uow, id: string, totals: { gross: string; totalDeductions: string; net: string }): Promise<PayslipRow> {
    return uow.one<PayslipRow>(
      `UPDATE payslips SET gross = $2, total_deductions = $3, net = $4 WHERE id = $1 RETURNING *`,
      [id, totals.gross, totals.totalDeductions, totals.net],
      'Payslip',
    );
  }
}

export type PayslipItemRow = BaseRow & {
  payslip_id: string;
  salary_component_id: string;
  component_name: string;
  type: string;
  amount: string;
  reason: string | null;
};

export class PayslipItemRepository extends BaseRepository<PayslipItemRow> {
  protected readonly table = 'payslip_items';
  protected readonly writableColumns = ['payslip_id', 'salary_component_id', 'component_name', 'type', 'amount', 'reason'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'payslip_items.id', index: 'payslip_items_pkey' } };

  async listForPayslip(uow: Uow, payslipId: string): Promise<PayslipItemRow[]> {
    return uow.many<PayslipItemRow>(`SELECT * FROM payslip_items WHERE payslip_id = $1 ORDER BY id`, [payslipId]);
  }
}
