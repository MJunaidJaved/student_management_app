import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type FormValues = { amount: string; method: 'cash' | 'bank' | 'online' | 'cheque'; referenceNo: string }

export function RecordPaymentDialog({
  invoiceId,
  outstanding,
  onClose,
}: {
  invoiceId: string
  outstanding: string
  onClose: () => void
}) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { amount: Number(outstanding).toFixed(2), method: 'cash', referenceNo: '' },
  })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const idempotencyKey = crypto.randomUUID()
      await apiClient.post(
        '/payments',
        {
          amount: values.amount,
          method: values.method,
          referenceNo: values.referenceNo || undefined,
          allocations: [{ invoiceId, amount: values.amount }],
        },
        { headers: { 'idempotency-key': idempotencyKey } },
      )
    },
    onSuccess: () => {
      show('success', 'Payment recorded')
      queryClient.invalidateQueries({ queryKey: ['invoices', invoiceId] })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Record Payment" size="sm">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div>
          <Label>Amount</Label>
          <Input type="number" step="0.01" {...register('amount', { required: true })} />
          <p className="mt-1 text-xs text-ink-muted">Outstanding: {Number(outstanding).toLocaleString()}</p>
        </div>
        <div>
          <Label>Method</Label>
          <Select {...register('method')}>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="online">Online</option>
            <option value="cheque">Cheque</option>
          </Select>
        </div>
        <div>
          <Label>Reference No (optional)</Label>
          <Input {...register('referenceNo')} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Record Payment
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
