import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_accounting__', password: 'AcctPassw0rd!2026' };

/*
 * Account heads are find-or-create and never torn down: once a voucher is
 * posted against one, `voucher_entries_account_head_id_fkey` (RESTRICT) and
 * the immutability of a posted voucher (`guard_posted_voucher`) make that
 * head permanently referenced. See fees.api.test.ts for the fuller version
 * of this reasoning — the same FK-RESTRICT chain applies here.
 */
const CASH_HEAD_CODE = '__TESTACCT-CASH';
const INCOME_HEAD_CODE = '__TESTACCT-INC';

let server: Server;
let baseUrl: string;
let token: string;

// Only a draft (never posted) voucher is safely deletable; it is the only
// thing this suite tears down.
const made = { draftVouchers: [] as string[] };

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function findOrCreateAccountHead(code: string, name: string, type: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM account_heads WHERE code = $1`, [code]));
  if (existing) return existing.id;
  const res = await call('/api/v1/account-heads', { method: 'POST', body: { code, name, type } });
  if (res.status !== 201) throw new Error('Could not create fixture account head: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(ADMIN.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [ADMIN.username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [existing.id]);
    } else {
      const u = await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`, [ADMIN.username, hash]);
      await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, SUPER_ADMIN_ROLE]);
    }
  });
  const login = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: ADMIN.username, password: ADMIN.password } });
  if (login.status !== 200) throw new Error('Login failed: ' + JSON.stringify(login.body));
  token = login.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    await uow.count(`DELETE FROM voucher_entries WHERE voucher_id = ANY($1)`, [made.draftVouchers]);
    await uow.count(`DELETE FROM vouchers WHERE id = ANY($1)`, [made.draftVouchers]);
  });
  server.close();
  await closePool();
});

describe('Accounting API', () => {
  let cashHeadId: string, incomeHeadId: string;
  let baselineCashBalance: number, baselineCashTrialDebit: number;

  beforeAll(async () => {
    cashHeadId = await findOrCreateAccountHead(CASH_HEAD_CODE, 'Test cash in hand', 'asset');
    incomeHeadId = await findOrCreateAccountHead(INCOME_HEAD_CODE, 'Test income', 'income');

    // These heads are reused across runs, so later balance/trial-balance
    // assertions compare against this baseline rather than an absolute
    // figure that would only hold on a database with no prior run's residue.
    const balance = await call(`/api/v1/reports/accounting/account-heads/${cashHeadId}/balance?asOf=2026-12-31`);
    baselineCashBalance = Number(balance.body.data.balance);
    const trial = await call('/api/v1/reports/accounting/trial-balance?asOf=2026-12-31');
    const cashRow = trial.body.data.rows.find((r: { accountHeadId: string }) => r.accountHeadId === cashHeadId);
    baselineCashTrialDebit = cashRow ? Number(cashRow.debit) : 0;
  });

  it('rejects a voucher with fewer than two entries', async () => {
    const res = await call('/api/v1/vouchers', { method: 'POST', body: { type: 'journal', voucherDate: '2026-05-01', entries: [{ accountHeadId: cashHeadId, debit: '100.00' }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an entry carrying both a debit and a credit', async () => {
    const res = await call('/api/v1/vouchers', { method: 'POST', body: { type: 'journal', voucherDate: '2026-05-01', entries: [
      { accountHeadId: cashHeadId, debit: '100.00', credit: '100.00' },
      { accountHeadId: incomeHeadId, credit: '100.00' },
    ] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  let unbalancedVoucherId: string;
  it('creates a draft voucher whose debits and credits do not match', async () => {
    const res = await call('/api/v1/vouchers', { method: 'POST', body: { type: 'journal', voucherDate: '2026-05-01', narration: '__test unbalanced', entries: [
      { accountHeadId: cashHeadId, debit: '100.00' },
      { accountHeadId: incomeHeadId, credit: '90.00' },
    ] } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('draft');
    unbalancedVoucherId = res.body.data.id;
    made.draftVouchers.push(unbalancedVoucherId);
  });

  it('refuses to post an unbalanced voucher (database-enforced)', async () => {
    const res = await call(`/api/v1/vouchers/${unbalancedVoucherId}/post`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VOUCHER_UNBALANCED');

    const check = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ status: string }>(`SELECT status FROM vouchers WHERE id = $1`, [unbalancedVoucherId]));
    expect(check.status).toBe('draft');
  });

  let voucherId: string;
  it('creates and posts a balanced manual voucher', async () => {
    const create = await call('/api/v1/vouchers', { method: 'POST', body: { type: 'journal', voucherDate: '2026-05-02', narration: '__test balanced', entries: [
      { accountHeadId: cashHeadId, debit: '500.00' },
      { accountHeadId: incomeHeadId, credit: '500.00' },
    ] } });
    expect(create.status).toBe(201);
    expect(create.body.data.status).toBe('draft');
    voucherId = create.body.data.id;

    const post = await call(`/api/v1/vouchers/${voucherId}/post`, { method: 'POST' });
    expect(post.status).toBe(200);
    expect(post.body.data.status).toBe('posted');
  });

  it('retrieves the posted voucher with its entries', async () => {
    const res = await call(`/api/v1/vouchers/${voucherId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('posted');
    expect(res.body.data.entries.length).toBe(2);
    const totalDebit = res.body.data.entries.reduce((s: number, e: { debit: string }) => s + Number(e.debit), 0);
    const totalCredit = res.body.data.entries.reduce((s: number, e: { credit: string }) => s + Number(e.credit), 0);
    expect(totalDebit).toBe(500);
    expect(totalCredit).toBe(500);
  });

  it('a posted voucher is immutable (database-enforced)', async () => {
    // The thrown message is translate-error.ts's friendly wording (every
    // query is translated, including this direct one), not the raw trigger
    // text ("Posted voucher is immutable").
    await expect(transaction(SYSTEM_ACTOR, (uow) => uow.count(`UPDATE vouchers SET narration = 'tampered' WHERE id = $1`, [voucherId]))).rejects.toThrow(/A posted voucher cannot be changed/i);
  });

  it('a posted voucher cannot be posted again', async () => {
    const res = await call(`/api/v1/vouchers/${voucherId}/post`, { method: 'POST' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VOUCHER_NOT_DRAFT');
  });

  it('lists vouchers filtered by type and status', async () => {
    const res = await call(`/api/v1/vouchers?type=journal&status=posted`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((v: { id: string }) => v.id === voucherId)).toBe(true);
    expect(res.body.data.items.every((v: { status: string }) => v.status === 'posted')).toBe(true);
  });

  it("reports the cash head's balance including the posted voucher", async () => {
    const res = await call(`/api/v1/reports/accounting/account-heads/${cashHeadId}/balance?asOf=2026-12-31`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.balance) - baselineCashBalance).toBeCloseTo(500, 2);
  });

  it("reports the cash head's ledger for the date range", async () => {
    const res = await call(`/api/v1/reports/accounting/ledger/${cashHeadId}?from=2026-01-01&to=2026-12-31`);
    expect(res.status).toBe(200);
    expect(res.body.data.entries.some((e: { debit: string; voucherNo: string }) => e.debit === '500.00' && e.voucherNo)).toBe(true);
  });

  it('produces a trial balance that balances', async () => {
    const res = await call('/api/v1/reports/accounting/trial-balance?asOf=2026-12-31');
    expect(res.status).toBe(200);
    expect(res.body.data.totalDebit).toBe(res.body.data.totalCredit);
    const cashRow = res.body.data.rows.find((r: { accountHeadId: string }) => r.accountHeadId === cashHeadId);
    expect(Number(cashRow.debit) - baselineCashTrialDebit).toBeCloseTo(500, 2);
  });

  it('a request without accounting.read is forbidden', async () => {
    const noAuth = await fetch(`${baseUrl}/api/v1/account-heads`, { method: 'GET', headers: { 'content-type': 'application/json' } });
    expect(noAuth.status).toBe(401);
  });

  it('a request without accounting.post is forbidden for posting', async () => {
    const noAuth = await fetch(`${baseUrl}/api/v1/vouchers/${unbalancedVoucherId}/post`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(noAuth.status).toBe(401);
  });
});
