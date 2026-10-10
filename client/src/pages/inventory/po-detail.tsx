import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Truck, Ban, PackageCheck } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { useToast } from '@/components/ui/toast'
import type { PurchaseOrderDetail, SupplierView } from './types'
import { ReceivePoDialog } from './receive-po-dialog'

export function PoDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [receiveOpen, setReceiveOpen] = useState(false)

  const po = useApiQuery<PurchaseOrderDetail>(['inventory', 'purchase-order', id], `/purchase-orders/${id}`)
  const suppliers = useApiQuery<{ suppliers: SupplierView[] }>(['inventory', 'suppliers'], '/suppliers')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory', 'purchase-order', id] })
    queryClient.invalidateQueries({ queryKey: ['inventory', 'purchase-orders'] })
  }

  const markOrdered = useMutation({
    mutationFn: async () => apiClient.post(`/purchase-orders/${id}/mark-ordered`),
    onSuccess: () => {
      show('success', 'Marked as ordered')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const cancel = useMutation({
    mutationFn: async () => apiClient.post(`/purchase-orders/${id}/cancel`),
    onSuccess: () => {
      show('success', 'Purchase order cancelled')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (po.isLoading) return <PageLoading />
  if (po.isError || !po.data) return <ErrorState description="Could not load this purchase order." />

  const p = po.data
  const supplierName = suppliers.data?.suppliers.find((s) => s.id === p.supplierId)?.name ?? p.supplierId
  const fullyReceived = p.items.every((it) => Number(it.received) >= Number(it.quantity))

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" onClick={() => navigate('/inventory')} className="mb-2">
        <ArrowLeft className="size-4" />
        Back to Inventory
      </Button>

      <PageHeader
        title={p.poNo}
        description={`${supplierName} — ${p.orderDate}`}
        actions={
          <>
            <Badge tone={statusTone(p.status)} className="mr-2">
              {p.status}
            </Badge>
            {p.status === 'draft' && hasPermission('inventory.manage_purchase_orders') && (
              <Button size="sm" loading={markOrdered.isPending} onClick={() => markOrdered.mutate()}>
                <Truck className="size-4" />
                Mark Ordered
              </Button>
            )}
            {p.status === 'ordered' && hasPermission('inventory.receive_purchase_order') && !fullyReceived && (
              <Button size="sm" onClick={() => setReceiveOpen(true)}>
                <PackageCheck className="size-4" />
                Receive
              </Button>
            )}
            {(p.status === 'draft' || p.status === 'ordered') && hasPermission('inventory.manage_purchase_orders') && (
              <Button variant="danger" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                <Ban className="size-4" />
                Cancel
              </Button>
            )}
          </>
        }
      />

      <Card>
        <Table>
          <Thead>
            <Tr>
              <Th>Item</Th>
              <Th>SKU</Th>
              <Th>Ordered</Th>
              <Th>Received</Th>
              <Th>Unit Cost</Th>
            </Tr>
          </Thead>
          <Tbody>
            {p.items.map((it) => (
              <Tr key={it.id}>
                <Td className="font-medium text-ink">{it.itemName}</Td>
                <Td>{it.sku}</Td>
                <Td>{it.quantity}</Td>
                <Td>{it.received}</Td>
                <Td>{it.unitCost}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>

      {receiveOpen && <ReceivePoDialog poId={id} lines={p.items} onClose={() => setReceiveOpen(false)} />}
    </div>
  )
}
