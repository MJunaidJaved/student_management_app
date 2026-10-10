import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, EmptyState, ErrorState } from '@/components/ui/feedback'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import type { FeeInvoiceView } from './types'
import { GenerateInvoiceDialog } from './generate-invoice-dialog'

export function InvoicesTab() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { classes } = useAcademicLookups()
  const [status, setStatus] = useState('')
  const [classId, setClassId] = useState('')
  const [generateOpen, setGenerateOpen] = useState(false)

  const list = useCursorList<FeeInvoiceView>(['invoices'], '/invoices', {
    status: status || undefined,
    classId: classId || undefined,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <Select
            className="w-auto min-w-[140px]"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              list.reset()
            }}
          >
            <option value="">All statuses</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <Select
            className="w-auto min-w-[140px]"
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value)
              list.reset()
            }}
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        {hasPermission('fees.generate_invoices') && (
          <Button onClick={() => setGenerateOpen(true)}>
            <Plus className="size-4" />
            Generate Invoice
          </Button>
        )}
      </div>

      <Card>
        {list.isLoading ? (
          <PageLoading />
        ) : list.isError ? (
          <ErrorState description="Could not load invoices." />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState title="No invoices match these filters" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Invoice No</Th>
                  <Th>Billing Period</Th>
                  <Th>Due Date</Th>
                  <Th>Total</Th>
                  <Th>Outstanding</Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {list.data.items.map((inv) => (
                  <Tr key={inv.id} className="cursor-pointer" onClick={() => navigate(`/fees/invoices/${inv.id}`)}>
                    <Td className="font-medium text-brand-600">{inv.invoiceNo}</Td>
                    <Td>{inv.billingPeriod}</Td>
                    <Td>{inv.dueDate}</Td>
                    <Td>{Number(inv.total).toLocaleString()}</Td>
                    <Td>{Number(inv.outstanding).toLocaleString()}</Td>
                    <Td>
                      <Badge tone={statusTone(inv.status)}>{inv.status}</Badge>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <p className="text-xs text-ink-muted">Page {list.page}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={!list.hasPrev} onClick={list.prevPage}>
                  <ChevronLeft className="size-4" />
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={!list.hasNext} onClick={list.nextPage}>
                  Next
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {generateOpen && <GenerateInvoiceDialog onClose={() => setGenerateOpen(false)} />}
    </div>
  )
}
