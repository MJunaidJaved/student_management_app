export type AccountHeadType = 'asset' | 'liability' | 'income' | 'expense' | 'equity'
export type AccountHeadView = { id: string; code: string; name: string; type: AccountHeadType; parentId: string | null; isActive: boolean }
export type BankAccountView = { id: string; bankName: string; accountTitle: string; accountNo: string; openingBalance: string; accountHeadId: string | null }

export type VoucherType = 'receipt' | 'payment' | 'journal'
export type VoucherStatus = 'draft' | 'posted'
export type VoucherView = { id: string; voucherNo: string; type: VoucherType; voucherDate: string; narration: string | null; sourceType: string | null; sourceId: string | null; status: VoucherStatus }
export type VoucherEntryView = { id: string; accountHeadId: string; accountHeadCode: string; accountHeadName: string; debit: string; credit: string }
export type VoucherDetail = VoucherView & { entries: VoucherEntryView[] }

export type LedgerEntry = { voucherNo: string; voucherDate: string; narration: string | null; debit: string; credit: string }
export type AccountHeadBalance = { debit: string; credit: string; balance: string }
export type TrialBalanceRow = { accountHeadId: string; code: string; name: string; type: AccountHeadType; debit: string; credit: string }
export type TrialBalance = { rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string }
