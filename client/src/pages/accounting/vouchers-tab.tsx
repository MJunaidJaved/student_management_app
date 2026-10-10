import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useAuth } from '@/lib/auth-context'
import type { VoucherStatus, VoucherType, VoucherView } from './types'
import { CreateVoucherDialog } from './create-voucher-dialog'
import { VoucherDetailDialog } from './voucher-detail-dialog'

export function VouchersTab() {
  const { hasPermission } = useAuth()
  const [type, setType] = useState<VoucherType | ''>('')
  const [status, setStatus] = useState<VoucherStatus | ''>('')
  const [createOpen, setCreateOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)

  const list = useCursorList<VoucherView>(['accounting', 'vouchers', type, status], '/vouchers', {
    type: type || undefined,
    status: status || undefined,
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Type</label>
            <Select className="w-36" value={type} onChange={(e) => setType(e.target.value as VoucherType | '')}>
              <option value="">All</option>
              <option value="journal">Journal</option>
              <option value="receipt">Receipt</option>
              <option value="payment">Payment</option>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
            <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as VoucherStatus | '')}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
            </Select>
          </div>
          {hasPermission('accounting.manage_vouchers') && (
            <div className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Voucher
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        {list.isLoading ? (
          <PageLoading />
        ) : list.isError ? (
          <ErrorState description="Could not load vouchers." />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState title="No vouchers found" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Voucher No</Th>
                  <Th>Type</Th>
                  <Th>Date</Th>
                  <Th>Narration</Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {list.data.items.map((v) => (
                  <Tr key={v.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => setActiveId(v.id)}>
                    <Td className="font-medium text-brand-600">{v.voucherNo}</Td>
                    <Td className="capitalize">{v.type}</Td>
                    <Td>{v.voucherDate}</Td>
                    <Td className="max-w-[200px] truncate">{v.narration ?? '—'}</Td>
                    <Td>
                      <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={!list.hasPrev} onClick={list.prevPage}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={!list.hasNext} onClick={list.nextPage}>
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {createOpen && <CreateVoucherDialog onClose={() => setCreateOpen(false)} />}
      {activeId && <VoucherDetailDialog id={activeId} onClose={() => setActiveId(null)} />}
    </div>
  )
}
