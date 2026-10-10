import { useState } from 'react'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import type { AccountHeadBalance, AccountHeadView, LedgerEntry, TrialBalance } from './types'

function LedgerCard() {
  const heads = useApiQuery<{ accountHeads: AccountHeadView[] }>(['accounting', 'heads'], '/account-heads')
  const [accountHeadId, setAccountHeadId] = useState('')
  const [from, setFrom] = useState(() => new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10))
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10))

  const ledger = useApiQuery<{ entries: LedgerEntry[] }>(
    ['accounting', 'ledger', accountHeadId, from, to],
    `/reports/accounting/ledger/${accountHeadId}?from=${from}&to=${to}`,
    { enabled: !!accountHeadId },
  )
  const balance = useApiQuery<AccountHeadBalance>(['accounting', 'balance', accountHeadId], `/reports/accounting/account-heads/${accountHeadId}/balance`, {
    enabled: !!accountHeadId,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account Ledger</CardTitle>
      </CardHeader>
      <div className="flex flex-wrap items-end gap-3 p-5 pt-0">
        <Select className="w-52" value={accountHeadId} onChange={(e) => setAccountHeadId(e.target.value)}>
          <option value="">Select account head…</option>
          {heads.data?.accountHeads.map((h) => (
            <option key={h.id} value={h.id}>
              {h.code} — {h.name}
            </option>
          ))}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {balance.data && (
          <span className="text-sm text-ink-muted">
            Balance: <span className="font-medium text-ink">{balance.data.balance}</span>
          </span>
        )}
      </div>
      {!accountHeadId ? (
        <EmptyState title="Select an account head to view its ledger" />
      ) : ledger.isLoading ? (
        <PageLoading />
      ) : !ledger.data || ledger.data.entries.length === 0 ? (
        <EmptyState title="No ledger entries in this range" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Voucher No</Th>
              <Th>Date</Th>
              <Th>Narration</Th>
              <Th>Debit</Th>
              <Th>Credit</Th>
            </Tr>
          </Thead>
          <Tbody>
            {ledger.data.entries.map((e, i) => (
              <Tr key={`${e.voucherNo}-${i}`}>
                <Td className="font-medium text-ink">{e.voucherNo}</Td>
                <Td>{e.voucherDate}</Td>
                <Td>{e.narration ?? '—'}</Td>
                <Td>{e.debit}</Td>
                <Td>{e.credit}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

function TrialBalanceCard() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10))
  const trial = useApiQuery<TrialBalance>(['accounting', 'trial-balance', asOf], `/reports/accounting/trial-balance?asOf=${asOf}`)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trial Balance</CardTitle>
      </CardHeader>
      <div className="p-5 pt-0">
        <Input type="date" className="w-44" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      {trial.isLoading ? (
        <PageLoading />
      ) : !trial.data || trial.data.rows.length === 0 ? (
        <EmptyState title="No posted entries as of this date" />
      ) : (
        <>
          <Table>
            <Thead>
              <Tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Debit</Th>
                <Th>Credit</Th>
              </Tr>
            </Thead>
            <Tbody>
              {trial.data.rows.map((r) => (
                <Tr key={r.accountHeadId}>
                  <Td>{r.code}</Td>
                  <Td className="font-medium text-ink">{r.name}</Td>
                  <Td className="capitalize">{r.type}</Td>
                  <Td>{r.debit}</Td>
                  <Td>{r.credit}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          <div className="flex justify-end gap-6 border-t border-border p-4 text-sm font-medium text-ink">
            <span>Total Debit: {trial.data.totalDebit}</span>
            <span>Total Credit: {trial.data.totalCredit}</span>
          </div>
        </>
      )}
    </Card>
  )
}

export function AccountingReportsTab() {
  return (
    <div className="space-y-4">
      <LedgerCard />
      <TrialBalanceCard />
    </div>
  )
}
