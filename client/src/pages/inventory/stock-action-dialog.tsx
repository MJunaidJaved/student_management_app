import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { ItemView } from './types'

export function StockActionDialog({ item, mode, onClose }: { item: ItemView; mode: 'issue' | 'adjust'; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()

  const issueForm = useForm<{ quantity: string; referenceType: string }>()
  const adjustForm = useForm<{ quantityDelta: string; reason: string }>()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory', 'items'] })
    queryClient.invalidateQueries({ queryKey: ['inventory', 'movements', item.id] })
  }

  const issue = useMutation({
    mutationFn: async (v: { quantity: string; referenceType: string }) =>
      apiClient.post('/stock/issue', { itemId: item.id, quantity: v.quantity, referenceType: v.referenceType || undefined }),
    onSuccess: () => {
      show('success', 'Stock issued')
      invalidate()
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const adjust = useMutation({
    mutationFn: async (v: { quantityDelta: string; reason: string }) =>
      apiClient.post('/stock/adjust', { itemId: item.id, quantityDelta: v.quantityDelta, reason: v.reason }),
    onSuccess: () => {
      show('success', 'Stock adjusted')
      invalidate()
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (mode === 'issue') {
    return (
      <Dialog open onClose={onClose} title={`Issue Stock — ${item.name}`} size="sm">
        <form onSubmit={issueForm.handleSubmit((v) => issue.mutate(v))} className="space-y-4">
          <p className="text-sm text-ink-muted">Current stock: {item.stockQuantity} {item.unit}</p>
          <div>
            <Label>Quantity</Label>
            <Input type="number" step="0.01" {...issueForm.register('quantity', { required: true })} />
          </div>
          <div>
            <Label>Reference (optional)</Label>
            <Input placeholder="e.g. department, student" {...issueForm.register('referenceType')} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={issue.isPending}>
              Issue
            </Button>
          </div>
        </form>
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={onClose} title={`Adjust Stock — ${item.name}`} size="sm">
      <form onSubmit={adjustForm.handleSubmit((v) => adjust.mutate(v))} className="space-y-4">
        <p className="text-sm text-ink-muted">Current stock: {item.stockQuantity} {item.unit}</p>
        <div>
          <Label>Quantity Change (+/-)</Label>
          <Input type="number" step="0.01" placeholder="-5 or 10" {...adjustForm.register('quantityDelta', { required: true })} />
        </div>
        <div>
          <Label>Reason</Label>
          <Input {...adjustForm.register('reason', { required: true })} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={adjust.isPending}>
            Adjust
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
