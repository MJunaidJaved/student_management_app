import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { PayslipDetail, SalaryComponentView } from './types'

type AdjustmentForm = { salaryComponentId: string; type: string; amount: string; reason: string }

export function PayslipDialog({ payslipId, runStatus, onClose }: { payslipId: string; runStatus: string; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const components = useApiQuery<{ components: SalaryComponentView[] }>(['payroll', 'components'], '/salary-components')
  const payslip = useApiQuery<PayslipDetail>(['payroll', 'payslip', payslipId], `/payslips/${payslipId}`)

  const { register, handleSubmit, reset } = useForm<AdjustmentForm>({ defaultValues: { type: 'earning' } })

  const addAdjustment = useMutation({
    mutationFn: async (v: AdjustmentForm) =>
      apiClient.post(`/payslips/${payslipId}/adjustments`, {
        salaryComponentId: v.salaryComponentId,
        type: v.type,
        amount: v.amount,
        reason: v.reason,
      }),
    onSuccess: () => {
      reset()
      show('success', 'Adjustment added')
      queryClient.invalidateQueries({ queryKey: ['payroll', 'payslip', payslipId] })
      queryClient.invalidateQueries({ queryKey: ['payroll', 'payslips'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const canAdjust = hasPermission('payroll.adjust') && runStatus === 'draft'

  return (
    <Dialog open onClose={onClose} title="Payslip" size="md">
      {payslip.isLoading || !payslip.data ? (
        <PageLoading />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-ink-subtle">Gross</p>
              <p className="text-lg font-semibold text-ink">{payslip.data.gross}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">Deductions</p>
              <p className="text-lg font-semibold text-ink">{payslip.data.totalDeductions}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">Net</p>
              <p className="text-lg font-semibold text-brand-600">{payslip.data.net}</p>
            </div>
          </div>

          <Table>
            <Thead>
              <Tr>
                <Th>Component</Th>
                <Th>Type</Th>
                <Th>Amount</Th>
                <Th>Reason</Th>
              </Tr>
            </Thead>
            <Tbody>
              {payslip.data.items.map((it) => (
                <Tr key={it.id}>
                  <Td>{it.componentName}</Td>
                  <Td className="capitalize">{it.type}</Td>
                  <Td>{it.amount}</Td>
                  <Td>{it.reason ?? '—'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>

          {canAdjust && (
            <form onSubmit={handleSubmit((v) => addAdjustment.mutate(v))} className="flex flex-wrap items-end gap-3 border-t border-border pt-4">
              <div>
                <Label>Component</Label>
                <Select {...register('salaryComponentId', { required: true })}>
                  <option value="">Select…</option>
                  {components.data?.components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Type</Label>
                <Select {...register('type')}>
                  <option value="earning">Earning</option>
                  <option value="deduction">Deduction</option>
                </Select>
              </div>
              <div>
                <Label>Amount</Label>
                <Input type="number" step="0.01" className="w-28" {...register('amount', { required: true })} />
              </div>
              <div className="min-w-[160px] flex-1">
                <Label>Reason</Label>
                <Input {...register('reason', { required: true })} />
              </div>
              <Button type="submit" loading={addAdjustment.isPending}>
                Add
              </Button>
            </form>
          )}

          <div className="flex justify-end pt-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
