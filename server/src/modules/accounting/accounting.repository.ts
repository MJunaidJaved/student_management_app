/**
 * Accounting data access (Module 10, the basic-ledger slice Section 3 needs):
 * account heads, bank accounts, vouchers and their entries.
 *
 * `vouchers`/`voucher_entries` already carry the whole double-entry
 * guarantee at the database level: `check_voucher_balance` (a deferred
 * constraint trigger) refuses to let a voucher's status become `posted`
 * unless its entries' debits equal its credits and are non-zero, and
 * `guard_posted_voucher` makes a posted voucher and its entries immutable.
 * Nothing here re-validates the balance before posting — the trigger is the
 * authority, and `translate-error.ts` already turns its failure into
 * `VOUCHER_UNBALANCED`.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import type { SortMap } from '../../core/db/query-builder';
import { BusinessRuleError } from '../../core/errors';

/* ------------------------------------------------------------------ *
 * Account heads
 * ------------------------------------------------------------------ */

export type AccountHeadRow = BaseRow & { code: string; name: string; type: string; parent_id: string | null; is_active: boolean };

export class AccountHeadRepository extends BaseRepository<AccountHeadRow> {
  protected readonly table = 'account_heads';
  protected readonly writableColumns = ['code', 'name', 'type', 'parent_id'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'code';
  protected readonly sortable: SortMap = { code: { column: 'account_heads.code', index: 'account_heads_code_key' } };

  async listAll(uow: Uow): Promise<AccountHeadRow[]> {
    return uow.many<AccountHeadRow>(`SELECT * FROM account_heads ORDER BY code`);
  }

  async findByCode(uow: Uow, code: string): Promise<AccountHeadRow | null> {
    return uow.maybeOne<AccountHeadRow>(`SELECT * FROM account_heads WHERE code = $1`, [code]);
  }

  /**
   * An account head's balance: the recursive roll-up Part 9.4 asks for, so a
   * parent head's balance includes its children. Debit-natured heads (asset,
   * expense) read as debit-minus-credit; credit-natured heads (liability,
   * income, equity) read the other way, which is what makes a trial balance
   * sum to zero.
   */
  async balance(uow: Uow, accountHeadId: string, asOf?: string): Promise<{ debit: string; credit: string; balance: string }> {
    const row = await uow.one<{ debit: string; credit: string; type: string }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM account_heads WHERE id = $1
         UNION ALL
         SELECT ah.id FROM account_heads ah JOIN tree t ON ah.parent_id = t.id
       )
       SELECT
         COALESCE(SUM(ve.debit), 0)::text AS debit,
         COALESCE(SUM(ve.credit), 0)::text AS credit,
         (SELECT type FROM account_heads WHERE id = $1) AS type
       FROM voucher_entries ve
       JOIN vouchers v ON v.id = ve.voucher_id AND v.status = 'posted'
       WHERE ve.account_head_id IN (SELECT id FROM tree)
         AND ($2::date IS NULL OR v.voucher_date <= $2)`,
      [accountHeadId, asOf ?? null],
    );
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const natural = row.type === 'asset' || row.type === 'expense';
    const balance = natural ? debit - credit : credit - debit;
    return { debit: row.debit, credit: row.credit, balance: balance.toFixed(2) };
  }
}

/* ------------------------------------------------------------------ *
 * Bank accounts
 * ------------------------------------------------------------------ */

export type BankAccountRow = BaseRow & { bank_name: string; account_title: string; account_no: string; opening_balance: string; account_head_id: string | null; is_active: boolean };

export class BankAccountRepository extends BaseRepository<BankAccountRow> {
  protected readonly table = 'bank_accounts';
  protected readonly writableColumns = ['bank_name', 'account_title', 'account_no', 'opening_balance', 'account_head_id'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'bank_name';
  protected readonly sortable: SortMap = { bank_name: { column: 'bank_accounts.bank_name', index: 'bank_accounts_pkey (small table)' } };

  async listAll(uow: Uow): Promise<BankAccountRow[]> {
    return uow.many<BankAccountRow>(`SELECT * FROM bank_accounts ORDER BY bank_name`);
  }
}

/* ------------------------------------------------------------------ *
 * Vouchers and entries
 * ------------------------------------------------------------------ */

export type VoucherRow = BaseRow & {
  voucher_no: string;
  type: string;
  voucher_date: string;
  narration: string | null;
  source_type: string | null;
  source_id: string | null;
  status: string;
  created_by: string | null;
};

export class VoucherRepository extends BaseRepository<VoucherRow> {
  protected readonly table = 'vouchers';
  protected readonly writableColumns = ['type', 'voucher_date', 'narration', 'source_type', 'source_id', 'created_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = {
    created_at: { column: 'vouchers.created_at', index: 'vouchers_pkey' },
    voucher_no: { column: 'vouchers.voucher_no', index: 'vouchers_voucher_no_key' },
  };

  /**
   * Idempotent lookup for event-driven posting: at most one voucher per
   * (source_type, source_id) — not a database constraint (there is none on
   * this pair), so the check is here, done before insert inside the same
   * transaction as the business event, which is what makes "never post
   * twice for the same payment" hold even under retry.
   */
  async findForSource(uow: Uow, sourceType: string, sourceId: string): Promise<VoucherRow | null> {
    return uow.maybeOne<VoucherRow>(`SELECT * FROM vouchers WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId]);
  }

  async post(uow: Uow, id: string): Promise<VoucherRow> {
    return uow.one<VoucherRow>(`UPDATE vouchers SET status = 'posted' WHERE id = $1 AND status = 'draft' RETURNING *`, [id], 'Voucher');
  }

  async listFiltered(
    uow: Uow,
    filters: { type?: string | undefined; status?: string | undefined; from?: string | undefined; to?: string | undefined },
    page: { limit: number; cursorId?: string | undefined },
  ): Promise<VoucherRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.type) { params.push(filters.type); conditions.push(`type = $${params.length}`); }
    if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
    if (filters.from) { params.push(filters.from); conditions.push(`voucher_date >= $${params.length}`); }
    if (filters.to) { params.push(filters.to); conditions.push(`voucher_date <= $${params.length}`); }
    if (page.cursorId) { params.push(page.cursorId); conditions.push(`id < $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(page.limit + 1);
    return uow.many<VoucherRow>(`SELECT * FROM vouchers ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
  }
}

export type VoucherEntryRow = BaseRow & { voucher_id: string; account_head_id: string; debit: string; credit: string };

export class VoucherEntryRepository extends BaseRepository<VoucherEntryRow> {
  protected readonly table = 'voucher_entries';
  protected readonly writableColumns = ['voucher_id', 'account_head_id', 'debit', 'credit'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'voucher_entries.id', index: 'voucher_entries_pkey' } };

  async forVoucher(uow: Uow, voucherId: string): Promise<(VoucherEntryRow & { account_head_code: string; account_head_name: string })[]> {
    return uow.many(
      `SELECT ve.*, ah.code AS account_head_code, ah.name AS account_head_name
         FROM voucher_entries ve JOIN account_heads ah ON ah.id = ve.account_head_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [voucherId],
    );
  }

  /** Ledger lines for one account head over a range — the ledger report. */
  async ledgerForAccountHead(uow: Uow, accountHeadId: string, from: string, to: string): Promise<{ voucher_no: string; voucher_date: string; narration: string | null; debit: string; credit: string }[]> {
    return uow.many(
      `SELECT v.voucher_no, v.voucher_date, v.narration, ve.debit, ve.credit
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.account_head_id = $1 AND v.status = 'posted' AND v.voucher_date BETWEEN $2 AND $3
        ORDER BY v.voucher_date, v.id`,
      [accountHeadId, from, to],
    );
  }

  /**
   * Note: the posted/date filter must sit inside the subquery, not in the
   * outer LEFT JOIN's ON clause — putting it there only nulls out `v`'s
   * columns for a non-matching row, it does not drop the `ve` row that the
   * first join already pulled in, which silently counted draft and
   * out-of-range entries toward the trial balance.
   */
  async trialBalance(uow: Uow, asOf: string): Promise<{ account_head_id: string; code: string; name: string; type: string; debit: string; credit: string }[]> {
    return uow.many(
      `SELECT ah.id AS account_head_id, ah.code, ah.name, ah.type,
              COALESCE(SUM(ve.debit), 0)::text AS debit,
              COALESCE(SUM(ve.credit), 0)::text AS credit
         FROM account_heads ah
    LEFT JOIN (
           SELECT ve.account_head_id, ve.debit, ve.credit
             FROM voucher_entries ve
             JOIN vouchers v ON v.id = ve.voucher_id
            WHERE v.status = 'posted' AND v.voucher_date <= $1
         ) ve ON ve.account_head_id = ah.id
        GROUP BY ah.id, ah.code, ah.name, ah.type
        HAVING COALESCE(SUM(ve.debit), 0) <> 0 OR COALESCE(SUM(ve.credit), 0) <> 0
        ORDER BY ah.code`,
      [asOf],
    );
  }
}

export function assertVoucherIsDraft(voucher: VoucherRow): void {
  if (voucher.status !== 'draft') {
    throw new BusinessRuleError('Only a draft voucher can be changed or posted.', 'VOUCHER_NOT_DRAFT');
  }
}
