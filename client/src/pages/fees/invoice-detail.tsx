import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Wallet, XCircle } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import { useToast } from '@/components/ui/toast'
import type { InvoiceDetail } from './types'
import { RecordPaymentDialog } from './record-payment-dialog'

function money(v: string | number) {
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function InvoiceDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [payOpen, setPayOpen] = useState(false)

  const detail = useApiQuery<InvoiceDetail>(['invoices', id], `/invoices/${id}`)

  const cancel = useMutation({
    mutationFn: async () => apiClient.post(`/invoices/${id}/cancel`),
    onSuccess: () => {
      show('success', 'Invoice cancelled')
      queryClient.invalidateQueries({ queryKey: ['invoices', id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (detail.isLoading) return <PageLoading />
  if (detail.isError || !detail.data) return <ErrorState description="Could not load this invoice." />

  const inv = detail.data

  return (
    <RequirePermission anyOf={['fees.read_own']}>
      <div className="mx-auto max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => navigate('/fees')} className="mb-2">
          <ArrowLeft className="size-4" />
          Back to Fees
        </Button>

        <PageHeader
          title={inv.invoiceNo}
          description={`Billing period ${inv.billingPeriod}`}
          actions={
            <>
              <Badge tone={statusTone(inv.status)} className="mr-2">
                {inv.status}
              </Badge>
              {hasPermission('fees.collect') && (inv.status === 'unpaid' || inv.status === 'partial') && (
                <Button size="sm" onClick={() => setPayOpen(true)}>
                  <Wallet className="size-4" />
                  Record Payment
                </Button>
              )}
              {hasPermission('fees.cancel_invoice') && inv.payments.length === 0 && inv.status !== 'cancelled' && (
                <Button variant="danger" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  <XCircle className="size-4" />
                  Cancel
                </Button>
              )}
            </>
          }
        />

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card className="p-4">
            <p className="text-xs text-ink-subtle">Subtotal</p>
            <p className="text-lg font-semibold text-ink">{money(inv.subtotal)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-subtle">Discount</p>
            <p className="text-lg font-semibold text-ink">{money(inv.discountTotal)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-subtle">Total</p>
            <p className="text-lg font-semibold text-ink">{money(inv.total)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-ink-subtle">Outstanding</p>
            <p className="text-lg font-semibold text-danger-500">{money(inv.outstanding)}</p>
          </Card>
        </div>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Line Items</CardTitle>
          </CardHeader>
          <Table>
            <Thead>
              <Tr>
                <Th>Category</Th>
                <Th>Amount</Th>
                <Th>Discount</Th>
              </Tr>
            </Thead>
            <Tbody>
              {inv.items.map((it) => (
                <Tr key={it.id}>
                  <Td>{it.feeCategoryName}</Td>
                  <Td>{money(it.amount)}</Td>
                  <Td>{money(it.discountAmount)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Payment History</CardTitle>
          </CardHeader>
          <CardContent>
            {inv.payments.length === 0 ? (
              <p className="text-sm text-ink-muted">No payments recorded yet.</p>
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Receipt No</Th>
                    <Th>Paid At</Th>
                    <Th>Amount</Th>
                    <Th>Status</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {inv.payments.map((p) => (
                    <Tr key={p.paymentId}>
                      <Td className="font-medium text-brand-600">{p.receiptNo}</Td>
                      <Td>{p.paidAt}</Td>
                      <Td>{money(p.amount)}</Td>
                      <Td>
                        <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        {payOpen && <RecordPaymentDialog invoiceId={inv.id} outstanding={inv.outstanding} onClose={() => setPayOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
