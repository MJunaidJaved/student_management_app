import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { AccountingService } from './accounting.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const accountHeadBody = z.object({ code: text(20), name: text(80), type: z.enum(['asset', 'liability', 'income', 'expense', 'equity']), parentId: idParam.nullable().optional() }).strict();
const bankAccountBody = z.object({ bankName: text(80), accountTitle: text(80), accountNo: text(40), openingBalance: moneyAmount.optional(), accountHeadId: idParam.nullable().optional() }).strict();
const voucherBody = z.object({
  type: z.enum(['receipt', 'payment', 'journal']),
  voucherDate: isoDate,
  narration: text(300).optional(),
  entries: z.array(z.object({ accountHeadId: idParam, debit: moneyAmount.optional(), credit: moneyAmount.optional() }).strict()).min(2).max(50),
}).strict();

export function accountingRoutes(accounting: AccountingService): RouteDeclaration[] {
  return [
    /* ---------------- setup ---------------- */
    { method: 'get', path: '/account-heads', summary: 'List account heads', permission: 'accounting.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ accountHeads: await accounting.listAccountHeads(actorOf(req)) })) },
    {
      method: 'post', path: '/account-heads', summary: 'Create an account head', permission: 'accounting.manage_heads', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: accountHeadBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof accountHeadBody }>(req); return created(await accounting.createAccountHead(actorOf(req), body)); }),
    },
    { method: 'get', path: '/bank-accounts', summary: 'List bank accounts', permission: 'accounting.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ bankAccounts: await accounting.listBankAccounts(actorOf(req)) })) },
    {
      method: 'post', path: '/bank-accounts', summary: 'Create a bank account', permission: 'accounting.manage_heads', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: bankAccountBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof bankAccountBody }>(req); return created(await accounting.createBankAccount(actorOf(req), body)); }),
    },

    /* ---------------- vouchers ---------------- */
    {
      method: 'post', path: '/vouchers', summary: 'Create a draft journal voucher', permission: 'accounting.manage_vouchers', ownership: 'none', rateLimit: 'money',
      schemas: { body: voucherBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof voucherBody }>(req); return created(await accounting.createVoucher(actorOf(req), body)); }),
    },
    {
      method: 'post', path: '/vouchers/:id/post', summary: 'Post a draft voucher (becomes immutable)', permission: 'accounting.post', ownership: 'none', rateLimit: 'money',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await accounting.postVoucher(actorOf(req), params.id)); }),
      errors: ['VOUCHER_NOT_DRAFT', 'VOUCHER_UNBALANCED'],
    },
    {
      method: 'get', path: '/vouchers/:id', summary: 'Get a voucher with its entries', permission: 'accounting.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await accounting.getVoucher(actorOf(req), params.id)); }),
    },
    {
      method: 'get', path: '/vouchers', summary: 'List vouchers', permission: 'accounting.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ type: z.enum(['receipt', 'payment', 'journal']).optional(), status: z.enum(['draft', 'posted']).optional(), from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); const { limit, cursor, ...filters } = query as { limit: number; cursor?: string; type?: string; status?: string; from?: string; to?: string }; return okBody(await accounting.listVouchers(actorOf(req), filters, { limit, cursor })); }),
    },

    /* ---------------- reports ---------------- */
    {
      method: 'get', path: '/reports/accounting/ledger/:id', summary: "An account head's ledger over a date range", permission: 'accounting.read', ownership: 'none', rateLimit: 'expensive',
      schemas: { params: z.object({ id: idParam }).strict(), query: z.object({ from: isoDate, to: isoDate }).strict() },
      handler: handler(async (req) => { const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req); const { from, to } = query as { from: string; to: string }; return okBody({ entries: await accounting.getLedger(actorOf(req), (params as { id: string }).id, from, to) }); }),
    },
    {
      method: 'get', path: '/reports/accounting/account-heads/:id/balance', summary: "An account head's running balance", permission: 'accounting.read', ownership: 'none', rateLimit: 'expensive',
      schemas: { params: z.object({ id: idParam }).strict(), query: z.object({ asOf: isoDate.optional() }).strict() },
      handler: handler(async (req) => { const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req); return okBody(await accounting.getAccountHeadBalance(actorOf(req), (params as { id: string }).id, (query as { asOf?: string }).asOf)); }),
    },
    {
      method: 'get', path: '/reports/accounting/trial-balance', summary: 'Trial balance as of a date', permission: 'accounting.read', ownership: 'none', rateLimit: 'expensive',
      schemas: { query: z.object({ asOf: isoDate }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody(await accounting.getTrialBalance(actorOf(req), (query as { asOf: string }).asOf)); }),
    },
  ];
}
