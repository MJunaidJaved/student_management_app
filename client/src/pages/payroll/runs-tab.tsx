import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Dialog } from '@/components/ui/dialog'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { PayrollRunStatus, PayrollRunView } from './types'
import { MONTH_NAMES } from './types'

function CreateRunDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { register, handleSubmit } = useForm<{ payMonth: string; payYear: string }>({
    defaultValues: { payMonth: String(new Date().getMonth() + 1), payYear: String(new Date().getFullYear()) },
  })

  const create = useMutation({
    mutationFn: async (v: { payMonth: string; payYear: string }) =>
      apiClient.post('/payroll-runs', { payMonth: Number(v.payMonth), payYear: Number(v.payYear) }),
    onSuccess: (res: { data: { data: PayrollRunView } }) => {
      show('success', 'Payroll run created')
      queryClient.invalidateQueries({ queryKey: ['payroll', 'runs'] })
      onClose()
      navigate(`/payroll/runs/${res.data.data.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Payroll Run" size="sm">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Month</Label>
            <Select {...register('payMonth', { required: true })}>
              {MONTH_NAMES.slice(1).map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Year</Label>
            <Input type="number" {...register('payYear', { required: true })} />
          </div>
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

export function RunsTab() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const [status, setStatus] = useState<PayrollRunStatus | ''>('')
  const [createOpen, setCreateOpen] = useState(false)

  const runs = useApiQuery<{ runs: PayrollRunView[] }>(['payroll', 'runs', status], `/payroll-runs${status ? `?status=${status}` : ''}`)

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
            <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as PayrollRunStatus | '')}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
            </Select>
          </div>
          {hasPermission('payroll.run') && (
            <div className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Run
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        {runs.isLoading ? (
          <PageLoading />
        ) : runs.isError ? (
          <ErrorState description="Could not load payroll runs." />
        ) : !runs.data || runs.data.runs.length === 0 ? (
          <EmptyState title="No payroll runs found" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Period</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {runs.data.runs.map((r) => (
                <Tr key={r.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => navigate(`/payroll/runs/${r.id}`)}>
                  <Td className="font-medium text-brand-600">
                    {MONTH_NAMES[r.payMonth]} {r.payYear}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {createOpen && <CreateRunDialog onClose={() => setCreateOpen(false)} />}
    </div>
  )
}
