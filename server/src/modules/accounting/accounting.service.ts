/**
 * Accounting (Module 10) — the basic, auditable ledger this phase needs,
 * built on the double-entry tables and triggers that already exist (see
 * accounting.repository.ts's header). This is not a general ledger product:
 * no budgets, no expenses, no bank reconciliation. It posts what a fee
 * payment and its reversal actually are — a receipt and its offset — and
 * lets an accountant enter anything else as a manual journal voucher.
 *
 * Auto-posting is deliberately all-or-nothing per payment: if the cash/bank
 * side or any fee category's income head cannot be resolved, nothing is
 * posted for that payment rather than posting a voucher that silently
 * misses part of the amount. A posted voucher must balance exactly (the
 * database enforces that), so "post most of it" is not a safe middle
 * ground — it is reported here as a deferred posting, and the accountant
 * can enter it by hand once the missing account head is configured.
 */

import { transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ValidationError } from '../../core/errors';
import { Money } from '../../core/money/money';
import {
  AccountHeadRepository,
  BankAccountRepository,
  VoucherRepository,
  VoucherEntryRepository,
  assertVoucherIsDraft,
  type AccountHeadRow,
  type BankAccountRow,
  type VoucherRow,
} from './accounting.repository';

export type AccountHeadView = { id: string; code: string; name: string; type: string; parentId: string | null; isActive: boolean };
function toHeadView(r: AccountHeadRow): AccountHeadView {
  return { id: r.id, code: r.code, name: r.name, type: r.type, parentId: r.parent_id, isActive: r.is_active };
}

export type BankAccountView = { id: string; bankName: string; accountTitle: string; accountNo: string; openingBalance: string; accountHeadId: string | null };
function toBankView(r: BankAccountRow): BankAccountView {
  return { id: r.id, bankName: r.bank_name, accountTitle: r.account_title, accountNo: r.account_no, openingBalance: r.opening_balance, accountHeadId: r.account_head_id };
}

export type VoucherView = { id: string; voucherNo: string; type: string; voucherDate: string; narration: string | null; sourceType: string | null; sourceId: string | null; status: string };
function toVoucherView(r: VoucherRow): VoucherView {
  return { id: r.id, voucherNo: r.voucher_no, type: r.type, voucherDate: r.voucher_date, narration: r.narration, sourceType: r.source_type, sourceId: r.source_id, status: r.status };
}

/**
 * Split `total` across weighted shares so they sum back to it exactly
 * (largest-remainder method, the same idea `allocateEvenly` uses for equal
 * shares). Needed because an invoice's fee categories almost never divide a
 * payment amount evenly, and a posted voucher must balance to the last
 * paisa, not approximately.
 */
function splitProportionally(total: Money, weights: readonly { key: string; weight: Money }[]): Map<string, Money> {
  const totalWeight = Money.sum(weights.map((w) => w.weight));
  const result = new Map<string, Money>();
  if (totalWeight.isZero() || weights.length === 0) return result;

  // total * (weight / totalWeight), quantized, with the last entry
  // absorbing whatever rounding remainder the others left — so the shares
  // always sum back to exactly `total`, never a paisa over or under.
  let distributed = Money.zero();
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    const isLast = i === weights.length - 1;
    const proportion = Number(w.weight.toString()) / Number(totalWeight.toString());
    const share = isLast ? total.minus(distributed) : total.times(proportion.toString()).quantize();
    result.set(w.key, (result.get(w.key) ?? Money.zero()).plus(share));
    distributed = distributed.plus(share);
  }
  return result;
}

export class AccountingService {
  constructor(
    private readonly accountHeads: AccountHeadRepository,
    private readonly bankAccounts: BankAccountRepository,
    private readonly vouchers: VoucherRepository,
    private readonly voucherEntries: VoucherEntryRepository,
  ) {}

  /* ---------------- account heads and bank accounts (setup) ---------------- */

  async listAccountHeads(actor: Actor): Promise<AccountHeadView[]> {
    return transaction(actor, async (uow) => (await this.accountHeads.listAll(uow)).map(toHeadView));
  }

  async createAccountHead(actor: Actor, input: { code: string; name: string; type: string; parentId?: string | null | undefined }): Promise<AccountHeadView> {
    return transaction(actor, async (uow) => toHeadView(await this.accountHeads.create(uow, { code: input.code, name: input.name, type: input.type, parent_id: input.parentId ?? null })));
  }

  async listBankAccounts(actor: Actor): Promise<BankAccountView[]> {
    return transaction(actor, async (uow) => (await this.bankAccounts.listAll(uow)).map(toBankView));
  }

  async createBankAccount(actor: Actor, input: { bankName: string; accountTitle: string; accountNo: string; openingBalance?: string | undefined; accountHeadId?: string | null | undefined }): Promise<BankAccountView> {
    return transaction(actor, async (uow) => toBankView(await this.bankAccounts.create(uow, { bank_name: input.bankName, account_title: input.accountTitle, account_no: input.accountNo, opening_balance: Money.of(input.openingBalance ?? '0').quantize().toString(), account_head_id: input.accountHeadId ?? null })));
  }

  /* ---------------- manual vouchers ---------------- */

  async createVoucher(actor: Actor, input: { type: string; voucherDate: string; narration?: string | undefined; entries: { accountHeadId: string; debit?: string | undefined; credit?: string | undefined }[] }): Promise<VoucherView> {
    return transaction(actor, async (uow) => {
      if (input.entries.length < 2) {
        throw new ValidationError('A voucher needs at least two entries.', [{ field: 'entries', message: 'Must have at least two lines.' }]);
      }
      for (const e of input.entries) {
        const d = Money.of(e.debit ?? '0');
        const c = Money.of(e.credit ?? '0');
        if ((d.isPositive() && c.isPositive()) || (d.isZero() && c.isZero())) {
          throw new ValidationError('Each entry must have exactly one of debit or credit set.', [{ field: 'entries', message: 'Exactly one side per line.' }]);
        }
      }
      const voucher = await this.vouchers.create(uow, { type: input.type, voucher_date: input.voucherDate, narration: input.narration ?? null, created_by: actor.userId });
      await this.voucherEntries.createMany(uow, input.entries.map((e) => ({ voucher_id: voucher.id, account_head_id: e.accountHeadId, debit: Money.of(e.debit ?? '0').quantize().toString(), credit: Money.of(e.credit ?? '0').quantize().toString() })));
      return toVoucherView(voucher);
    });
  }

  /** Posting is final — `guard_posted_voucher` makes the voucher and its entries immutable afterward. */
  async postVoucher(actor: Actor, id: string): Promise<VoucherView> {
    return transaction(actor, async (uow) => {
      const existing = await this.vouchers.getById(uow, id);
      assertVoucherIsDraft(existing);
      return toVoucherView(await this.vouchers.post(uow, id));
    });
  }

  async getVoucher(actor: Actor, id: string) {
    return transaction(actor, async (uow) => {
      const voucher = await this.vouchers.getById(uow, id);
      const entries = await this.voucherEntries.forVoucher(uow, id);
      return { ...toVoucherView(voucher), entries: entries.map((e) => ({ id: e.id, accountHeadId: e.account_head_id, accountHeadCode: e.account_head_code, accountHeadName: e.account_head_name, debit: e.debit, credit: e.credit })) };
    });
  }

  async listVouchers(actor: Actor, filters: { type?: string | undefined; status?: string | undefined; from?: string | undefined; to?: string | undefined }, page: { limit: number; cursor?: string | undefined }) {
    return transaction(actor, async (uow) => {
      const rows = await this.vouchers.listFiltered(uow, filters, { limit: page.limit, cursorId: page.cursor });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return { items: items.map(toVoucherView), hasMore, nextCursor: hasMore && last ? last.id : null };
    });
  }

  /* ---------------- event-driven posting (called from FeesService, same transaction) ---------------- */

  /** Resolve the debit side for a payment: the account head behind its cash/bank movement. */
  private async resolveDebitHead(uow: Uow, method: string, bankAccountId: string | undefined): Promise<string | null> {
    if (method === 'cash') {
      const head = await this.accountHeads.findByCode(uow, 'CASH');
      return head?.id ?? null;
    }
    if (!bankAccountId) return null;
    const bank = await this.bankAccounts.getById(uow, bankAccountId);
    return bank.account_head_id;
  }

  /**
   * Credit side: for each allocation line, the invoice's items are split by
   * income head in proportion to their net (amount minus discount) share of
   * the invoice, then that proportion of the allocated amount is credited to
   * each head. Returns `null` — meaning "do not post" — if any item's fee
   * category has no income head configured, since a partial posting would
   * not balance.
   */
  private async resolveCreditLines(uow: Uow, lines: readonly { invoiceId: string; amount: string }[]): Promise<Map<string, Money> | null> {
    const totals = new Map<string, Money>();
    for (const line of lines) {
      const items = await uow.many<{ fee_category_id: string; amount: string; discount_amount: string; income_head_id: string | null }>(
        `SELECT it.fee_category_id, it.amount, it.discount_amount, fc.income_head_id
           FROM fee_invoice_items it JOIN fee_categories fc ON fc.id = it.fee_category_id
          WHERE it.invoice_id = $1`,
        [line.invoiceId],
      );
      if (items.some((it) => it.income_head_id === null)) return null;

      const weights = items.map((it) => ({ key: it.income_head_id!, weight: Money.of(it.amount).minus(it.discount_amount).clampToZero() }));
      const split = splitProportionally(Money.of(line.amount), weights);
      for (const [headId, amount] of split) {
        totals.set(headId, (totals.get(headId) ?? Money.zero()).plus(amount));
      }
    }
    return totals;
  }

  async postReceiptForPayment(
    uow: Uow,
    input: { paymentId: string; amount: string; method: string; bankAccountId?: string | undefined; lines: readonly { invoiceId: string; amount: string }[]; createdBy: number | null },
  ): Promise<VoucherView | null> {
    const existing = await this.vouchers.findForSource(uow, 'payment', input.paymentId);
    if (existing) return toVoucherView(existing); // Already posted for this payment; never post twice.

    const debitHeadId = await this.resolveDebitHead(uow, input.method, input.bankAccountId);
    if (!debitHeadId) return null;
    const credits = await this.resolveCreditLines(uow, input.lines);
    if (!credits) return null;

    const voucher = await this.vouchers.create(uow, { type: 'receipt', voucher_date: new Date().toISOString().slice(0, 10), narration: `Fee payment`, source_type: 'payment', source_id: input.paymentId, created_by: input.createdBy ? String(input.createdBy) : null });
    const entries = [{ voucher_id: voucher.id, account_head_id: debitHeadId, debit: Money.of(input.amount).quantize().toString(), credit: '0.00' }];
    for (const [headId, amount] of credits) entries.push({ voucher_id: voucher.id, account_head_id: headId, debit: '0.00', credit: amount.toString() });
    await this.voucherEntries.createMany(uow, entries);
    return toVoucherView(await this.vouchers.post(uow, voucher.id));
  }

  async postReversalForPayment(
    uow: Uow,
    input: { paymentId: string; amount: string; method: string; lines: readonly { invoiceId: string; amount: string }[]; createdBy: number | null },
  ): Promise<VoucherView | null> {
    const existing = await this.vouchers.findForSource(uow, 'payment_reversal', input.paymentId);
    if (existing) return toVoucherView(existing);

    const original = await this.vouchers.findForSource(uow, 'payment', input.paymentId);
    if (!original) return null; // Nothing was posted for the original payment; nothing to reverse.

    const originalEntries = await this.voucherEntries.forVoucher(uow, original.id);
    const voucher = await this.vouchers.create(uow, { type: 'receipt', voucher_date: new Date().toISOString().slice(0, 10), narration: `Reversal of payment`, source_type: 'payment_reversal', source_id: input.paymentId, created_by: input.createdBy ? String(input.createdBy) : null });
    // The exact mirror image: every debit becomes a credit and vice versa.
    await this.voucherEntries.createMany(uow, originalEntries.map((e) => ({ voucher_id: voucher.id, account_head_id: e.account_head_id, debit: e.credit, credit: e.debit })));
    return toVoucherView(await this.vouchers.post(uow, voucher.id));
  }

  /* ---------------- reports ---------------- */

  async getAccountHeadBalance(actor: Actor, accountHeadId: string, asOf?: string) {
    return transaction(actor, (uow) => this.accountHeads.balance(uow, accountHeadId, asOf));
  }

  async getLedger(actor: Actor, accountHeadId: string, from: string, to: string) {
    return transaction(actor, async (uow) => {
      const rows = await this.voucherEntries.ledgerForAccountHead(uow, accountHeadId, from, to);
      return rows.map((r) => ({ voucherNo: r.voucher_no, voucherDate: r.voucher_date, narration: r.narration, debit: r.debit, credit: r.credit }));
    });
  }

  async getTrialBalance(actor: Actor, asOf: string) {
    return transaction(actor, async (uow) => {
      const rows = await this.voucherEntries.trialBalance(uow, asOf);
      const totalDebit = Money.sum(rows.map((r) => r.debit));
      const totalCredit = Money.sum(rows.map((r) => r.credit));
      if (!totalDebit.equals(totalCredit)) {
        // The database guarantees this cannot actually happen (every posted
        // voucher balances); surfaced as a hard error rather than silently
        // shown wrong, in case it ever does.
        throw new BusinessRuleError('Trial balance does not balance; this indicates a data integrity problem.', 'TRIAL_BALANCE_MISMATCH');
      }
      return {
        rows: rows.map((r) => ({ accountHeadId: r.account_head_id, code: r.code, name: r.name, type: r.type, debit: r.debit, credit: r.credit })),
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString(),
      };
    });
  }
}
