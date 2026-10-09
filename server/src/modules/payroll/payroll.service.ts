/**
 * Payroll (Module 8).
 *
 * `basic_salary` on the effective-dated `staff_salaries` row is the only
 * persistent, recurring payroll figure the schema models — there is no
 * table linking a `salary_structure` to specific `salary_components` with
 * amounts or rates, so a recurring "this allowance is always 10% of basic"
 * rule is not something this schema can express, and inventing a table for
 * it was not asked for. Every earning or deduction beyond basic salary is
 * therefore a manual, one-off adjustment to a specific payslip, each with
 * its own reason — exactly the shape Part 11's "approved manual adjustments
 * with a recorded reason" already asks for, so that is the whole mechanism
 * rather than a fallback.
 *
 * `paid_on` (on `payslips`) cannot be set once a run leaves `draft`:
 * `guard_payslips` reads the *current* `payroll_runs.status` on every write
 * to a payslip, and that status is already `approved` (never `draft`) by
 * the time `markPaid` runs. So this implementation does not claim to
 * record an actual disbursement date — `payroll_runs.status = 'paid'` is
 * the authoritative signal that a run has been paid, and nothing here
 * claims money actually moved, per Part 15's own caution.
 */

import { transaction, readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, ForbiddenError, ValidationError } from '../../core/errors';
import type { PermissionService } from '../../core/authz/permission-service';
import { Money } from '../../core/money/money';
import { PAYROLL_RUN_TRANSITIONS, canTransition, type PayrollRunStatus } from '../../core/db/enums';
import type { StaffRepository } from '../staff/staff.repository';
import {
  SalaryComponentRepository,
  SalaryStructureRepository,
  StaffSalaryRepository,
  PayrollRunRepository,
  PayslipRepository,
  PayslipItemRepository,
  type SalaryComponentRow,
  type SalaryStructureRow,
  type StaffSalaryRow,
  type PayrollRunRow,
  type PayslipRow,
  type PayslipItemRow,
} from './payroll.repository';

/* ---------------- views ---------------- */

export type SalaryComponentView = { id: string; name: string; type: string; calcType: string };
function toComponentView(r: SalaryComponentRow): SalaryComponentView {
  return { id: r.id, name: r.name, type: r.type, calcType: r.calc_type };
}

export type SalaryStructureView = { id: string; name: string; description: string | null };
function toStructureView(r: SalaryStructureRow): SalaryStructureView {
  return { id: r.id, name: r.name, description: r.description };
}

export type StaffSalaryView = { id: string; staffId: string; salaryStructureId: string | null; basicSalary: string; effectiveFrom: string; effectiveTo: string | null };
function toSalaryView(r: StaffSalaryRow): StaffSalaryView {
  return { id: r.id, staffId: r.staff_id, salaryStructureId: r.salary_structure_id, basicSalary: r.basic_salary, effectiveFrom: r.effective_from, effectiveTo: r.effective_to };
}

export type PayrollRunView = { id: string; payMonth: number; payYear: number; status: string; runBy: string | null; approvedBy: string | null };
function toRunView(r: PayrollRunRow): PayrollRunView {
  return { id: r.id, payMonth: r.pay_month, payYear: r.pay_year, status: r.status, runBy: r.run_by, approvedBy: r.approved_by };
}

export type PayslipView = { id: string; payrollRunId: string; staffId: string; gross: string; totalDeductions: string; net: string; paidOn: string | null };
function toPayslipView(r: PayslipRow): PayslipView {
  return { id: r.id, payrollRunId: r.payroll_run_id, staffId: r.staff_id, gross: r.gross, totalDeductions: r.total_deductions, net: r.net, paidOn: r.paid_on };
}

export type PayslipItemView = { id: string; payslipId: string; salaryComponentId: string; componentName: string; type: string; amount: string; reason: string | null };
function toItemView(r: PayslipItemRow): PayslipItemView {
  return { id: r.id, payslipId: r.payslip_id, salaryComponentId: r.salary_component_id, componentName: r.component_name, type: r.type, amount: r.amount, reason: r.reason };
}

/** First and last calendar day of a pay period, as plain ISO dates. */
function periodBounds(payMonth: number, payYear: number): { start: string; end: string } {
  const start = new Date(Date.UTC(payYear, payMonth - 1, 1));
  const end = new Date(Date.UTC(payYear, payMonth, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export class PayrollService {
  constructor(
    private readonly components: SalaryComponentRepository,
    private readonly structures: SalaryStructureRepository,
    private readonly staffSalaries: StaffSalaryRepository,
    private readonly runs: PayrollRunRepository,
    private readonly payslips: PayslipRepository,
    private readonly items: PayslipItemRepository,
    private readonly staff: StaffRepository,
    private readonly permissions: PermissionService,
  ) {}

  private async heldPermissions(actor: Actor): Promise<ReadonlySet<string>> {
    return actor.userId === null ? new Set<string>() : this.permissions.forUser(actor.userId);
  }

  /* ---------------- salary components and structures ---------------- */

  async listComponents(actor: Actor): Promise<SalaryComponentView[]> {
    return readTransaction(actor, async (uow) => (await this.components.listAll(uow)).map(toComponentView));
  }

  async createComponent(actor: Actor, input: { name: string; type: string; calcType: string }): Promise<SalaryComponentView> {
    return transaction(actor, async (uow) => toComponentView(await this.components.create(uow, { name: input.name, type: input.type, calc_type: input.calcType })));
  }

  async listStructures(actor: Actor): Promise<SalaryStructureView[]> {
    return readTransaction(actor, async (uow) => (await this.structures.listAll(uow)).map(toStructureView));
  }

  async createStructure(actor: Actor, input: { name: string; description?: string | undefined }): Promise<SalaryStructureView> {
    return transaction(actor, async (uow) => toStructureView(await this.structures.create(uow, { name: input.name, description: input.description ?? null })));
  }

  /* ---------------- staff salary assignment ---------------- */

  async listSalaryHistory(actor: Actor, staffId: string): Promise<StaffSalaryView[]> {
    return readTransaction(actor, async (uow) => {
      await this.assertCanViewStaffPay(uow, actor, staffId);
      return (await this.staffSalaries.listForStaff(uow, staffId)).map(toSalaryView);
    });
  }

  private async assertCanViewStaffPay(uow: Uow, actor: Actor, staffId: string): Promise<void> {
    const held = await this.heldPermissions(actor);
    if (actor.userType === 'admin' || held.has('payroll.read')) return;
    if (held.has('payroll.read_own') && actor.userType === 'staff' && String(actor.staffId) === staffId) return;
    throw new ForbiddenError('You do not have permission to view this.');
  }

  /**
   * Assign a new effective-dated salary. Automatically closes whatever
   * assignment is currently open for this staff member the day before the
   * new one starts — the EXCLUDE constraint on `staff_salaries` would
   * otherwise refuse the overlap, and asking the caller to manage that
   * themselves is exactly the kind of bookkeeping this service exists to
   * remove.
   */
  async assignSalary(actor: Actor, input: { staffId: string; salaryStructureId?: string | undefined; basicSalary: string; effectiveFrom: string }): Promise<StaffSalaryView> {
    return transaction(actor, async (uow) => {
      const staffRow = await this.staff.getById(uow, input.staffId);
      if (staffRow.status !== 'active') {
        throw new BusinessRuleError('Only an active staff member can receive a new salary assignment.', 'STAFF_NOT_ACTIVE');
      }
      const open = await this.staffSalaries.findOpen(uow, input.staffId);
      if (open) {
        if (open.effective_from >= input.effectiveFrom) {
          throw new ValidationError('The new assignment must start after the current one began.', [{ field: 'effectiveFrom', message: 'Must be after the current assignment\'s start date.' }]);
        }
        const dayBefore = new Date(input.effectiveFrom);
        dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
        await this.staffSalaries.close(uow, open.id, dayBefore.toISOString().slice(0, 10));
      }
      const row = await this.staffSalaries.create(uow, {
        staff_id: input.staffId,
        salary_structure_id: input.salaryStructureId ?? null,
        basic_salary: Money.of(input.basicSalary).quantize().toString(),
        effective_from: input.effectiveFrom,
        effective_to: null,
      });
      return toSalaryView(row);
    });
  }

  /* ---------------- payroll runs ---------------- */

  async listRuns(actor: Actor, filters: { payYear?: number | undefined; status?: string | undefined }): Promise<PayrollRunView[]> {
    return readTransaction(actor, async (uow) => (await this.runs.listFiltered(uow, filters)).map(toRunView));
  }

  async getRun(actor: Actor, id: string): Promise<PayrollRunView> {
    return readTransaction(actor, async (uow) => toRunView(await this.runs.getById(uow, id)));
  }

  async createRun(actor: Actor, input: { payMonth: number; payYear: number }): Promise<PayrollRunView> {
    return transaction(actor, async (uow) => {
      const existing = await this.runs.findByPeriod(uow, input.payMonth, input.payYear);
      if (existing) throw new ConflictError(`A payroll run for ${input.payMonth}/${input.payYear} already exists.`, 'PAYROLL_RUN_EXISTS');
      const row = await this.runs.create(uow, { pay_month: input.payMonth, pay_year: input.payYear, status: 'draft', run_by: actor.userId });
      return toRunView(row);
    });
  }

  /**
   * Generate one base payslip per eligible active staff member — eligible
   * meaning active, joined on or before the period's last day, and not
   * separated before its first — using whichever salary assignment is
   * effective on the period's first day. Idempotent: a staff member who
   * already has a payslip for this run is skipped, not duplicated, the same
   * approach Section 3's bulk invoice generation uses.
   */
  async generatePayslips(actor: Actor, runId: string): Promise<{ created: number; skipped: string[] }> {
    return transaction(actor, async (uow) => {
      const run = await this.runs.getById(uow, runId);
      if (run.status !== 'draft') throw new BusinessRuleError('Payslips can only be generated while the run is a draft.', 'PAYROLL_RUN_NOT_DRAFT');
      const { start, end } = periodBounds(run.pay_month, run.pay_year);

      const eligible = await uow.many<{ id: string }>(
        `SELECT id::text AS id FROM staff
          WHERE status = 'active' AND deleted_at IS NULL
            AND join_date <= $1 AND (separation_date IS NULL OR separation_date >= $2)`,
        [end, start],
      );

      let created = 0;
      const skipped: string[] = [];
      for (const { id: staffId } of eligible) {
        const existingPayslip = await this.payslips.findForRunAndStaff(uow, runId, staffId);
        if (existingPayslip) continue;

        const salary = await this.staffSalaries.findEffectiveOn(uow, staffId, start);
        if (!salary) { skipped.push(staffId); continue; }

        const gross = Money.of(salary.basic_salary).quantize();
        await this.payslips.create(uow, {
          payroll_run_id: runId, staff_id: staffId, gross: gross.toString(), total_deductions: '0.00', net: gross.toString(), paid_on: null,
        });
        created += 1;
      }
      return { created, skipped };
    });
  }

  /**
   * A manual adjustment to one payslip: an extra earning or deduction, with
   * a reason, before the run is approved. Recomputes gross/deductions/net
   * from every line afterward rather than adding the delta in place — the
   * same "recompute the whole total, don't patch it" discipline Section 3
   * used for invoices, which is what makes a double-submitted adjustment
   * safe to retry rather than something that quietly compounds.
   */
  async addAdjustment(actor: Actor, payslipId: string, input: { salaryComponentId: string; type: 'earning' | 'deduction'; amount: string; reason: string }): Promise<{ payslip: PayslipView; items: PayslipItemView[] }> {
    return transaction(actor, async (uow) => {
      const payslip = await this.payslips.getById(uow, payslipId);
      const run = await this.runs.getById(uow, payslip.payroll_run_id);
      if (run.status !== 'draft') throw new BusinessRuleError('A payslip can only be adjusted while its run is a draft.', 'PAYROLL_RUN_NOT_DRAFT');

      const component = await this.components.getById(uow, input.salaryComponentId);
      if (component.type !== input.type) {
        throw new ValidationError(`"${component.name}" is a${component.type === 'earning' ? 'n' : ''} ${component.type}, not a${input.type === 'earning' ? 'n' : ''} ${input.type}.`, [{ field: 'type', message: 'Must match the component\'s own type.' }]);
      }

      // Basic salary is folded into `gross` but is not itself a line item,
      // so it has to be recovered as gross-minus-earnings — captured here,
      // before the new item exists, so it is not itself subtracted out.
      const itemsBefore = await this.items.listForPayslip(uow, payslipId);
      const earningsBefore = Money.sum(itemsBefore.filter((i) => i.type === 'earning').map((i) => i.amount));
      const basicSalary = Money.of(payslip.gross).minus(earningsBefore);

      await this.items.create(uow, {
        payslip_id: payslipId, salary_component_id: input.salaryComponentId, component_name: component.name,
        type: input.type, amount: Money.of(input.amount).quantize().toString(), reason: input.reason,
      });

      const allItems = await this.items.listForPayslip(uow, payslipId);
      const earnings = Money.sum(allItems.filter((i) => i.type === 'earning').map((i) => i.amount));
      const deductions = Money.sum(allItems.filter((i) => i.type === 'deduction').map((i) => i.amount));
      const gross = basicSalary.plus(earnings).quantize();
      const totalDeductions = deductions.quantize();
      const net = gross.minus(totalDeductions).clampToZero().quantize();

      const updated = await this.payslips.updateTotals(uow, payslipId, { gross: gross.toString(), totalDeductions: totalDeductions.toString(), net: net.toString() });
      return { payslip: toPayslipView(updated), items: allItems.map(toItemView) };
    });
  }

  private async transition(uow: Uow, id: string, to: PayrollRunStatus): Promise<PayrollRunRow> {
    const run = await this.runs.getById(uow, id);
    if (!canTransition(PAYROLL_RUN_TRANSITIONS, run.status as PayrollRunStatus, to)) {
      throw new BusinessRuleError(`A payroll run cannot go from "${run.status}" to "${to}".`, 'ILLEGAL_PAYROLL_TRANSITION');
    }
    return run;
  }

  async approveRun(actor: Actor, id: string): Promise<PayrollRunView> {
    return transaction(actor, async (uow) => {
      await this.transition(uow, id, 'approved');
      const payslipCount = await uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM payslips WHERE payroll_run_id = $1`, [id]);
      if (payslipCount.n === 0) throw new BusinessRuleError('This run has no payslips to approve.', 'PAYROLL_RUN_EMPTY');
      return toRunView(await this.runs.setStatus(uow, id, 'approved', { approvedBy: actor.userId === null ? undefined : String(actor.userId) }));
    });
  }

  async markRunPaid(actor: Actor, id: string): Promise<PayrollRunView> {
    return transaction(actor, async (uow) => {
      await this.transition(uow, id, 'paid');
      return toRunView(await this.runs.setStatus(uow, id, 'paid'));
    });
  }

  /* ---------------- payslips ---------------- */

  async getPayslip(actor: Actor, id: string): Promise<PayslipView & { items: PayslipItemView[] }> {
    return readTransaction(actor, async (uow) => {
      const payslip = await this.payslips.getById(uow, id);
      await this.assertCanViewStaffPay(uow, actor, payslip.staff_id);
      const items = await this.items.listForPayslip(uow, id);
      return { ...toPayslipView(payslip), items: items.map(toItemView) };
    });
  }

  async listPayslipsForRun(actor: Actor, runId: string): Promise<(PayslipView & { fullName: string; employeeNo: string })[]> {
    return readTransaction(actor, async (uow) => {
      const held = await this.heldPermissions(actor);
      if (actor.userType !== 'admin' && !held.has('payroll.read')) throw new ForbiddenError('You do not have permission to view this.');
      const rows = await this.payslips.listForRun(uow, runId);
      return rows.map((r) => ({ ...toPayslipView(r), fullName: r.full_name, employeeNo: r.employee_no }));
    });
  }

  async listPayslipsForStaff(actor: Actor, staffId: string): Promise<(PayslipView & { payMonth: number; payYear: number; runStatus: string })[]> {
    return readTransaction(actor, async (uow) => {
      await this.assertCanViewStaffPay(uow, actor, staffId);
      const rows = await this.payslips.listForStaff(uow, staffId);
      return rows.map((r) => ({ ...toPayslipView(r), payMonth: r.pay_month, payYear: r.pay_year, runStatus: r.run_status }));
    });
  }
}
