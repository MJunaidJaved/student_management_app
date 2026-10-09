import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_payroll__', password: 'PayrollPassw0rd!2026' };
const STAFF1 = { username: '__apitest_payroll_staff1__', password: 'PayrollStaff1!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let staff1Token: string;

// salary_components/salary_structures are not torn down — see
// findOrCreateComponent/findOrCreateStructure below.
const made = { staff: [] as string[], runs: [] as string[] };

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A component or structure that ends up attached to staff1's payslip can
 * never be deleted (see the afterAll comment below), and both tables have a
 * UNIQUE name — so, like fees.api.test.ts's account heads, these are
 * find-or-create fixtures reused across runs, not created fresh each time.
 */
async function findOrCreateComponent(name: string, type: string, calcType: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM salary_components WHERE name = $1`, [name]));
  if (existing) return existing.id;
  const res = await call('/api/v1/salary-components', { method: 'POST', body: { name, type, calcType } });
  if (res.status !== 201) throw new Error('Could not create fixture salary component: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

async function findOrCreateStructure(name: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM salary_structures WHERE name = $1`, [name]));
  if (existing) return existing.id;
  const res = await call('/api/v1/salary-structures', { method: 'POST', body: { name } });
  if (res.status !== 201) throw new Error('Could not create fixture salary structure: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

/**
 * A payroll run that reaches "paid" is as permanent as a posted voucher —
 * `payroll_runs_pay_month_pay_year_key` means that exact period can never
 * be run again. A fixed period would collide with itself on the very next
 * run of this file, so each run claims the next free slot instead, well
 * away from any real period (2090+, nowhere near production use).
 */
async function findFreePeriod(): Promise<{ month: number; year: number }> {
  for (let year = 2090; year <= 2099; year++) {
    for (let month = 1; month <= 12; month++) {
      const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM payroll_runs WHERE pay_month = $1 AND pay_year = $2`, [month, year]));
      if (!existing) return { month, year };
    }
  }
  throw new Error('No free test payroll period found in 2090-2099.');
}

function firstOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
}

/** The first day of the month *after* the given one — year rollover included. */
function firstOfNextMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

/** The last calendar day of the given month. */
function lastOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function ensureUser(username: string, password: string, role: string, staffId?: string): Promise<void> {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true, staff_id = $2 WHERE id = $1`, [existing.id, staffId ?? null]);
      return;
    }
    const hash = await hashPassword(password);
    const u = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, staff_id, must_change_password, is_active) VALUES ($1, $2, $3, $4, false, true) RETURNING id::text AS id`,
      [username, hash, staffId ? 'staff' : 'admin', staffId ?? null],
    );
    await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, role]);
  });
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await ensureUser(ADMIN.username, ADMIN.password, SUPER_ADMIN_ROLE);
  const adminLogin = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: ADMIN.username, password: ADMIN.password } });
  if (adminLogin.status !== 200) throw new Error('Admin login failed: ' + JSON.stringify(adminLogin.body));
  token = adminLogin.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    // Only a run still in `draft` is actually deletable — `guard_payslips`
    // makes a payslip (and, after migration 012, its items) immutable once
    // its run leaves draft, which in turn blocks deleting the run itself
    // (payslips.payroll_run_id is RESTRICT) and, transitively, any staff
    // member who has one (payslips.staff_id is RESTRICT too). This is the
    // same permanence Section 3 documented for a posted payment — `runId`
    // above ends this file approved-then-paid, so it and staff1 (who has a
    // payslip on it) are left as permanent residue, excluded by name in
    // refuse-real-data.ts, exactly like fees.api.test.ts's guardian.
    const runs = await uow.many<{ id: string; status: string }>(`SELECT id::text, status FROM payroll_runs WHERE id = ANY($1)`, [made.runs]);
    for (const run of runs.filter((r) => r.status === 'draft')) {
      await uow.count(`DELETE FROM payslip_items WHERE payslip_id IN (SELECT id FROM payslips WHERE payroll_run_id = $1)`, [run.id]);
      await uow.count(`DELETE FROM payslips WHERE payroll_run_id = $1`, [run.id]);
      await uow.count(`DELETE FROM payroll_runs WHERE id = $1`, [run.id]);
    }

    // staff2 never received a payslip, so it (and its salary row, if any)
    // are safely deletable; staff1 is not, once it has a payslip on a
    // non-draft run.
    const deletableStaff = await uow.many<{ id: string }>(
      `SELECT id::text AS id FROM staff WHERE id = ANY($1) AND id NOT IN (SELECT staff_id FROM payslips)`,
      [made.staff],
    );
    const deletableIds = deletableStaff.map((r) => r.id);
    await uow.count(`DELETE FROM staff_salaries WHERE staff_id = ANY($1)`, [deletableIds]);
    await uow.count(`UPDATE users SET staff_id = NULL WHERE staff_id = ANY($1)`, [deletableIds]);
    for (const id of deletableIds) await uow.count(`DELETE FROM staff WHERE id = $1`, [id]);

    // A permanently-stuck staff member (one with a payslip) stays "active"
    // with an open-ended salary assignment forever unless this closes it —
    // and if it stays active, every future run of this file's own
    // generatePayslips call would find it "eligible" all over again and
    // attach a second, unwanted payslip to its own new run. Separating it
    // the moment it becomes permanent keeps it out of every period from now
    // on, without touching the payslip or run that made it permanent.
    const stuckStaff = await uow.many<{ id: string }>(`SELECT id::text AS id FROM staff WHERE id = ANY($1) AND id IN (SELECT staff_id FROM payslips)`, [made.staff]);
    for (const { id } of stuckStaff) {
      await uow.count(`UPDATE staff SET status = 'resigned', separation_date = CURRENT_DATE WHERE id = $1 AND status = 'active'`, [id]);
    }
  });
  server.close();
  await closePool();
});

describe('Payroll API', () => {
  let staff1: string, staff2NoSalary: string;
  let earningComponent: string, deductionComponent: string, structureId: string;
  let period: { month: number; year: number };

  beforeAll(async () => {
    period = await findFreePeriod();

    const s1 = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Payroll Staff One', gender: 'male', dob: '1988-01-01', phone: '03007770001', joinDate: '2025-01-01' } });
    staff1 = s1.body.data.id;
    made.staff.push(staff1);
    await ensureUser(STAFF1.username, STAFF1.password, 'Teacher', staff1);
    const login1 = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: STAFF1.username, password: STAFF1.password } });
    staff1Token = login1.body.data.accessToken;

    const s2 = await call('/api/v1/staff', { method: 'POST', body: { fullName: 'Payroll Staff Two', gender: 'female', dob: '1990-01-01', phone: '03007770002', joinDate: '2025-01-01' } });
    staff2NoSalary = s2.body.data.id;
    made.staff.push(staff2NoSalary);

    earningComponent = await findOrCreateComponent('__test Bonus', 'earning', 'fixed');
    deductionComponent = await findOrCreateComponent('__test Fine', 'deduction', 'fixed');
    structureId = await findOrCreateStructure('__test Grade A');
  });

  it("assigns staff1's first salary", async () => {
    const res = await call('/api/v1/staff-salaries', { method: 'POST', body: { staffId: staff1, salaryStructureId: structureId, basicSalary: '50000', effectiveFrom: firstOfMonth(period.year, period.month) } });
    expect(res.status).toBe(201);
    expect(res.body.data.effectiveTo).toBeNull();
  });

  it('rejects a new assignment that does not start after the current one', async () => {
    const res = await call('/api/v1/staff-salaries', { method: 'POST', body: { staffId: staff1, basicSalary: '55000', effectiveFrom: firstOfMonth(period.year, period.month) } });
    expect(res.status).toBe(422);
  });

  it('a later assignment automatically closes the earlier one', async () => {
    const res = await call('/api/v1/staff-salaries', { method: 'POST', body: { staffId: staff1, basicSalary: '55000', effectiveFrom: firstOfNextMonth(period.year, period.month) } });
    expect(res.status).toBe(201);

    const history = await call(`/api/v1/staff/${staff1}/salary-history`);
    expect(history.status).toBe(200);
    expect(history.body.data.history.length).toBe(2);
    const first = history.body.data.history.find((h: { basicSalary: string }) => h.basicSalary === '50000.00');
    expect(first.effectiveTo).toBe(lastOfMonth(period.year, period.month));
  });

  let runId: string;
  it('creates a draft payroll run for the period', async () => {
    const res = await call('/api/v1/payroll-runs', { method: 'POST', body: { payMonth: period.month, payYear: period.year } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    runId = res.body.data.id;
    made.runs.push(runId);
  });

  it('refuses a duplicate run for the same period', async () => {
    const res = await call('/api/v1/payroll-runs', { method: 'POST', body: { payMonth: period.month, payYear: period.year } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYROLL_RUN_EXISTS');
  });

  it("generates payslips using the period's effective salary (50000, not the later 55000), skipping staff with no salary assigned", async () => {
    const generate = await call(`/api/v1/payroll-runs/${runId}/generate-payslips`, { method: 'POST' });
    expect(generate.status).toBe(200);
    expect(generate.body.data.created).toBe(1);
    expect(generate.body.data.skipped).toEqual([staff2NoSalary]);

    const list = await call(`/api/v1/payroll-runs/${runId}/payslips`);
    expect(list.body.data.payslips.length).toBe(1);
    expect(list.body.data.payslips[0].gross).toBe('50000.00');
    expect(list.body.data.payslips[0].net).toBe('50000.00');
  });

  it('generating again is idempotent: no duplicate payslip for staff1', async () => {
    const res = await call(`/api/v1/payroll-runs/${runId}/generate-payslips`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(0);
    const count = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM payslips WHERE payroll_run_id = $1`, [runId]));
    expect(count.n).toBe(1);
  });

  let payslipId: string;
  it('rejects an adjustment whose type does not match the component', async () => {
    const list = await call(`/api/v1/payroll-runs/${runId}/payslips`);
    payslipId = list.body.data.payslips[0].id;
    const res = await call(`/api/v1/payslips/${payslipId}/adjustments`, { method: 'POST', body: { salaryComponentId: earningComponent, type: 'deduction', amount: '1000', reason: 'typo test' } });
    expect(res.status).toBe(422);
  });

  it('adds an earning and a deduction adjustment, recomputing gross/deductions/net', async () => {
    const bonus = await call(`/api/v1/payslips/${payslipId}/adjustments`, { method: 'POST', body: { salaryComponentId: earningComponent, type: 'earning', amount: '2000', reason: 'Performance bonus' } });
    expect(bonus.status).toBe(201);
    expect(bonus.body.data.payslip.gross).toBe('52000.00');

    const fine = await call(`/api/v1/payslips/${payslipId}/adjustments`, { method: 'POST', body: { salaryComponentId: deductionComponent, type: 'deduction', amount: '500', reason: 'Late arrival' } });
    expect(fine.status).toBe(201);
    expect(fine.body.data.payslip.gross).toBe('52000.00');
    expect(fine.body.data.payslip.totalDeductions).toBe('500.00');
    expect(fine.body.data.payslip.net).toBe('51500.00');
    expect(fine.body.data.items.length).toBe(2);
  });

  it('a staff member can see their own payslip, not another\'s', async () => {
    const own = await call(`/api/v1/staff/${staff1}/payslips`, { token: staff1Token });
    expect(own.status).toBe(200);
    expect(own.body.data.payslips.length).toBe(1);

    const other = await call(`/api/v1/staff/${staff2NoSalary}/payslips`, { token: staff1Token });
    expect(other.status).toBe(403);
  });

  it('refuses to approve a run with no payslips', async () => {
    const emptyPeriod = await findFreePeriod();
    const empty = await call('/api/v1/payroll-runs', { method: 'POST', body: { payMonth: emptyPeriod.month, payYear: emptyPeriod.year } });
    made.runs.push(empty.body.data.id);
    const res = await call(`/api/v1/payroll-runs/${empty.body.data.id}/approve`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYROLL_RUN_EMPTY');
  });

  it('approves the run', async () => {
    const res = await call(`/api/v1/payroll-runs/${runId}/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });

  it('refuses a further adjustment once the run is approved (database-enforced)', async () => {
    const res = await call(`/api/v1/payslips/${payslipId}/adjustments`, { method: 'POST', body: { salaryComponentId: earningComponent, type: 'earning', amount: '100', reason: 'too late' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYROLL_RUN_NOT_DRAFT');
  });

  it('refuses to approve an already-approved run', async () => {
    const res = await call(`/api/v1/payroll-runs/${runId}/approve`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ILLEGAL_PAYROLL_TRANSITION');
  });

  it('marks the run paid', async () => {
    const res = await call(`/api/v1/payroll-runs/${runId}/mark-paid`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paid');
  });

  it('a role without any payroll permission is forbidden', async () => {
    const res = await fetch(`${baseUrl}/api/v1/payroll-runs`, { method: 'GET', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
  });
});
