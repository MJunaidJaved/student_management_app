import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { Envelope } from '@/types/api'
import type { PoStatus, PurchaseOrderView, SupplierView } from './types'
import { CreatePoDialog } from './create-po-dialog'

export function PurchaseOrdersTab() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const [status, setStatus] = useState<PoStatus | ''>('')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const cursor = cursorStack[cursorStack.length - 1]

  const suppliers = useApiQuery<{ suppliers: SupplierView[] }>(['inventory', 'suppliers'], '/suppliers')
  const supplierName = (id: string) => suppliers.data?.suppliers.find((s) => s.id === id)?.name ?? id

  const pos = useQuery({
    queryKey: ['inventory', 'purchase-orders', status, cursor],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (cursor) params.set('cursor', cursor)
      const res = await apiClient.get<Envelope<{ purchaseOrders: PurchaseOrderView[]; nextCursorId: string | null }>>(`/purchase-orders?${params.toString()}`)
      return res.data.data
    },
    placeholderData: keepPreviousData,
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
            <Select className="w-36" value={status} onChange={(e) => { setStatus(e.target.value as PoStatus | ''); setCursorStack([]) }}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="ordered">Ordered</option>
              <option value="received">Received</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </div>
          {hasPermission('inventory.manage_purchase_orders') && (
            <div className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Purchase Order
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        {pos.isLoading ? (
          <PageLoading />
        ) : pos.isError ? (
          <ErrorState description="Could not load purchase orders." />
        ) : !pos.data || pos.data.purchaseOrders.length === 0 ? (
          <EmptyState title="No purchase orders found" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>PO No</Th>
                  <Th>Supplier</Th>
                  <Th>Order Date</Th>
                  <Th>Total</Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {pos.data.purchaseOrders.map((po) => (
                  <Tr key={po.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => navigate(`/inventory/purchase-orders/${po.id}`)}>
                    <Td className="font-medium text-brand-600">{po.poNo}</Td>
                    <Td>{supplierName(po.supplierId)}</Td>
                    <Td>{po.orderDate}</Td>
                    <Td>{po.total}</Td>
                    <Td>
                      <Badge tone={statusTone(po.status)}>{po.status}</Badge>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!pos.data.nextCursorId}
                onClick={() => pos.data!.nextCursorId && setCursorStack((s) => [...s, pos.data!.nextCursorId!])}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {createOpen && <CreatePoDialog onClose={() => setCreateOpen(false)} />}
    </div>
  )
}
