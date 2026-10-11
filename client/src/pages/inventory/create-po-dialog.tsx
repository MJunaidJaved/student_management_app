import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { ItemView, PurchaseOrderView, SupplierView } from './types'

type Line = { itemId: string; quantity: string; unitCost: string }

export function CreatePoDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const suppliers = useApiQuery<{ suppliers: SupplierView[] }>(['inventory', 'suppliers'], '/suppliers')
  const items = useApiQuery<{ items: ItemView[]; nextCursorId: string | null }>(['inventory', 'items', 'all-for-po'], '/items?limit=100')

  const { register, handleSubmit } = useForm<{ supplierId: string; orderDate: string }>({
    defaultValues: { orderDate: new Date().toISOString().slice(0, 10) },
  })
  const [lines, setLines] = useState<Line[]>([{ itemId: '', quantity: '', unitCost: '' }])

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const create = useMutation({
    mutationFn: async (v: { supplierId: string; orderDate: string }) =>
      apiClient.post('/purchase-orders', {
        supplierId: v.supplierId,
        orderDate: v.orderDate,
        items: lines.filter((l) => l.itemId && l.quantity && l.unitCost),
      }),
    onSuccess: (res: { data: { data: PurchaseOrderView } }) => {
      show('success', 'Purchase order created')
      queryClient.invalidateQueries({ queryKey: ['inventory', 'purchase-orders'] })
      onClose()
      navigate(`/inventory/purchase-orders/${res.data.data.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Purchase Order" size="lg">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Supplier</Label>
            <Select {...register('supplierId', { required: true })}>
              <option value="">Select…</option>
              {suppliers.data?.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Order Date</Label>
            <Input type="date" {...register('orderDate', { required: true })} />
          </div>
        </div>

        <div>
          <Label>Items</Label>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Select className="min-w-[160px] flex-1" value={line.itemId} onChange={(e) => updateLine(i, { itemId: e.target.value })}>
                  <option value="">Select item…</option>
                  {items.data?.items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name} ({it.sku})
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="Qty"
                  className="w-24"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                />
                <Input
                  type="number"
                  step="0.01"
                  placeholder="Unit Cost"
                  className="w-28"
                  value={line.unitCost}
                  onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={lines.length === 1}
                  onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="size-4 text-danger-500" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setLines((ls) => [...ls, { itemId: '', quantity: '', unitCost: '' }])}>
            <Plus className="size-4" />
            Add Line
          </Button>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create Draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
