import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { AccountHeadView, BankAccountView } from './types'

function AccountHeadsCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const heads = useApiQuery<{ accountHeads: AccountHeadView[] }>(['accounting', 'heads'], '/account-heads')
  const { register, handleSubmit, reset } = useForm<{ code: string; name: string; type: string; parentId: string }>({ defaultValues: { type: 'asset' } })

  const create = useMutation({
    mutationFn: async (v: { code: string; name: string; type: string; parentId: string }) =>
      apiClient.post('/account-heads', { code: v.code, name: v.name, type: v.type, parentId: v.parentId || undefined }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['accounting', 'heads'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Account Heads</h3>
      {hasPermission('accounting.manage_heads') && (
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <Label>Code</Label>
            <Input className="w-24" {...register('code', { required: true })} />
          </div>
          <div className="min-w-[160px] flex-1">
            <Label>Name</Label>
            <Input {...register('name', { required: true })} />
          </div>
          <div>
            <Label>Type</Label>
            <Select {...register('type')}>
              <option value="asset">Asset</option>
              <option value="liability">Liability</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
              <option value="equity">Equity</option>
            </Select>
          </div>
          <div>
            <Label>Parent (optional)</Label>
            <Select {...register('parentId')}>
              <option value="">None</option>
              {heads.data?.accountHeads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.code} — {h.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>
      )}
      {heads.isLoading ? (
        <PageLoading />
      ) : !heads.data || heads.data.accountHeads.length === 0 ? (
        <EmptyState title="No account heads yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Status</Th>
            </Tr>
          </Thead>
          <Tbody>
            {heads.data.accountHeads.map((h) => (
              <Tr key={h.id}>
                <Td>{h.code}</Td>
                <Td className="font-medium text-ink">{h.name}</Td>
                <Td className="capitalize">{h.type}</Td>
                <Td>
                  <Badge tone={h.isActive ? 'success' : 'neutral'}>{h.isActive ? 'Active' : 'Inactive'}</Badge>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

function BankAccountsCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const accounts = useApiQuery<{ bankAccounts: BankAccountView[] }>(['accounting', 'bank-accounts'], '/bank-accounts')
  const heads = useApiQuery<{ accountHeads: AccountHeadView[] }>(['accounting', 'heads'], '/account-heads')
  const { register, handleSubmit, reset } = useForm<{ bankName: string; accountTitle: string; accountNo: string; openingBalance: string; accountHeadId: string }>()

  const create = useMutation({
    mutationFn: async (v: { bankName: string; accountTitle: string; accountNo: string; openingBalance: string; accountHeadId: string }) =>
      apiClient.post('/bank-accounts', {
        bankName: v.bankName,
        accountTitle: v.accountTitle,
        accountNo: v.accountNo,
        openingBalance: v.openingBalance || undefined,
        accountHeadId: v.accountHeadId || undefined,
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['accounting', 'bank-accounts'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('accounting.manage_heads') && (!accounts.data || accounts.data.bankAccounts.length === 0)) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Bank Accounts</h3>
      {hasPermission('accounting.manage_heads') && (
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <Label>Bank Name</Label>
            <Input {...register('bankName', { required: true })} />
          </div>
          <div>
            <Label>Account Title</Label>
            <Input {...register('accountTitle', { required: true })} />
          </div>
          <div>
            <Label>Account No</Label>
            <Input {...register('accountNo', { required: true })} />
          </div>
          <div>
            <Label>Opening Balance</Label>
            <Input type="number" step="0.01" className="w-28" {...register('openingBalance')} />
          </div>
          <div>
            <Label>Account Head</Label>
            <Select {...register('accountHeadId')}>
              <option value="">None</option>
              {heads.data?.accountHeads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.code} — {h.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>
      )}
      {accounts.isLoading ? (
        <PageLoading />
      ) : !accounts.data || accounts.data.bankAccounts.length === 0 ? (
        <EmptyState title="No bank accounts yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Bank</Th>
              <Th>Title</Th>
              <Th>Account No</Th>
              <Th>Opening Balance</Th>
            </Tr>
          </Thead>
          <Tbody>
            {accounts.data.bankAccounts.map((a) => (
              <Tr key={a.id}>
                <Td className="font-medium text-ink">{a.bankName}</Td>
                <Td>{a.accountTitle}</Td>
                <Td>{a.accountNo}</Td>
                <Td>{a.openingBalance}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

export function AccountingSetupTab() {
  return (
    <div className="space-y-4">
      <AccountHeadsCard />
      <BankAccountsCard />
    </div>
  )
}
