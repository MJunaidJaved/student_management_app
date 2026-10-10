import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { PurchaseOrderLine } from './types'

export function ReceivePoDialog({ poId, lines, onClose }: { poId: string; lines: PurchaseOrderLine[]; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const outstanding = lines.filter((l) => Number(l.received) < Number(l.quantity))
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(outstanding.map((l) => [l.itemId, (Number(l.quantity) - Number(l.received)).toString()])),
  )

  const receive = useMutation({
    mutationFn: async () => {
      const items = outstanding
        .map((l) => ({ itemId: l.itemId, quantity: quantities[l.itemId] }))
        .filter((l) => l.quantity && Number(l.quantity) > 0)
      await apiClient.post(`/purchase-orders/${poId}/receive`, { items })
    },
    onSuccess: () => {
      show('success', 'Purchase order received')
      queryClient.invalidateQueries({ queryKey: ['inventory', 'purchase-order', poId] })
      queryClient.invalidateQueries({ queryKey: ['inventory', 'purchase-orders'] })
      queryClient.invalidateQueries({ queryKey: ['inventory', 'items'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Receive Purchase Order" size="md">
      <div className="space-y-3">
        {outstanding.map((l) => (
          <div key={l.itemId} className="flex items-end gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">{l.itemName}</p>
              <p className="text-xs text-ink-subtle">
                Ordered {l.quantity}, received {l.received}
              </p>
            </div>
            <div>
              <Label>Receive Now</Label>
              <Input
                type="number"
                step="0.01"
                className="w-28"
                value={quantities[l.itemId] ?? ''}
                onChange={(e) => setQuantities((q) => ({ ...q, [l.itemId]: e.target.value }))}
              />
            </div>
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={receive.isPending} onClick={() => receive.mutate()}>
            Receive
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
