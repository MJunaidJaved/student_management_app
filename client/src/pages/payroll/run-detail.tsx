import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ListPlus, CheckCircle2, BadgeDollarSign } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, ErrorState, EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { useToast } from '@/components/ui/toast'
import type { PayrollRunView, PayslipListItem } from './types'
import { MONTH_NAMES } from './types'
import { PayslipDialog } from './payslip-dialog'

export function RunDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [activePayslip, setActivePayslip] = useState<string | null>(null)

  const run = useApiQuery<PayrollRunView>(['payroll', 'run', id], `/payroll-runs/${id}`)
  const payslips = useApiQuery<{ payslips: PayslipListItem[] }>(['payroll', 'payslips', id], `/payroll-runs/${id}/payslips`)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['payroll', 'run', id] })
    queryClient.invalidateQueries({ queryKey: ['payroll', 'payslips', id] })
  }

  const generate = useMutation({
    mutationFn: async () => apiClient.post(`/payroll-runs/${id}/generate-payslips`),
    onSuccess: () => {
      show('success', 'Payslips generated')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const approve = useMutation({
    mutationFn: async () => apiClient.post(`/payroll-runs/${id}/approve`),
    onSuccess: () => {
      show('success', 'Run approved')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const markPaid = useMutation({
    mutationFn: async () => apiClient.post(`/payroll-runs/${id}/mark-paid`),
    onSuccess: () => {
      show('success', 'Run marked as paid')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (run.isLoading) return <PageLoading />
  if (run.isError || !run.data) return <ErrorState description="Could not load this payroll run." />

  const r = run.data

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => navigate('/payroll')} className="mb-2">
        <ArrowLeft className="size-4" />
        Back to Payroll
      </Button>

      <PageHeader
        title={`${MONTH_NAMES[r.payMonth]} ${r.payYear}`}
        actions={
          <>
            <Badge tone={statusTone(r.status)} className="mr-2">
              {r.status}
            </Badge>
            {r.status === 'draft' && hasPermission('payroll.run') && (
              <Button variant="outline" size="sm" loading={generate.isPending} onClick={() => generate.mutate()}>
                <ListPlus className="size-4" />
                Generate Payslips
              </Button>
            )}
            {r.status === 'draft' && hasPermission('payroll.approve') && (
              <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
                <CheckCircle2 className="size-4" />
                Approve
              </Button>
            )}
            {r.status === 'approved' && hasPermission('payroll.mark_paid') && (
              <Button size="sm" loading={markPaid.isPending} onClick={() => markPaid.mutate()}>
                <BadgeDollarSign className="size-4" />
                Mark Paid
              </Button>
            )}
          </>
        }
      />

      <Card>
        {payslips.isLoading ? (
          <PageLoading />
        ) : !payslips.data || payslips.data.payslips.length === 0 ? (
          <EmptyState title="No payslips yet" description="Generate payslips for this period first." />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Employee</Th>
                <Th>Gross</Th>
                <Th>Deductions</Th>
                <Th>Net</Th>
                <Th>Paid On</Th>
              </Tr>
            </Thead>
            <Tbody>
              {payslips.data.payslips.map((p) => (
                <Tr key={p.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => setActivePayslip(p.id)}>
                  <Td className="font-medium text-brand-600">
                    {p.fullName} ({p.employeeNo})
                  </Td>
                  <Td>{p.gross}</Td>
                  <Td>{p.totalDeductions}</Td>
                  <Td className="font-medium text-ink">{p.net}</Td>
                  <Td>{p.paidOn ?? '—'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {activePayslip && <PayslipDialog payslipId={activePayslip} runStatus={r.status} onClose={() => setActivePayslip(null)} />}
    </div>
  )
}
