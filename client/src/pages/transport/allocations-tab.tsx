import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { StudentPicker, type PickableStudent } from '@/components/student-picker'
import type { AllocationView, RouteStopView, RouteView } from './types'

type SearchStudent = PickableStudent

function AllocateForm({ enrollmentId, onDone }: { enrollmentId: string; onDone: () => void }) {
  const { show } = useToast()
  const routes = useApiQuery<{ routes: RouteView[] }>(['transport', 'routes'], '/routes')
  const { register, handleSubmit, watch } = useForm<{ routeId: string; routeStopId: string; startDate: string }>({
    defaultValues: { startDate: new Date().toISOString().slice(0, 10) },
  })
  const routeId = watch('routeId')
  const stops = useApiQuery<{ stops: RouteStopView[] }>(['transport', 'stops', routeId], `/routes/${routeId}/stops`, { enabled: !!routeId })

  const allocate = useMutation({
    mutationFn: async (v: { routeStopId: string; startDate: string }) => apiClient.post('/transport-allocations', { enrollmentId, routeStopId: v.routeStopId, startDate: v.startDate }),
    onSuccess: () => {
      show('success', 'Allocated')
      onDone()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <form onSubmit={handleSubmit((v) => allocate.mutate(v))} className="flex flex-wrap items-end gap-3">
      <div>
        <Label>Route</Label>
        <Select {...register('routeId', { required: true })}>
          <option value="">Select…</option>
          {routes.data?.routes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Stop</Label>
        <Select {...register('routeStopId', { required: true })} disabled={!routeId}>
          <option value="">Select…</option>
          {stops.data?.stops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.stopName} ({s.monthlyFee})
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Start Date</Label>
        <Input type="date" {...register('startDate', { required: true })} />
      </div>
      <Button type="submit" loading={allocate.isPending}>
        Allocate
      </Button>
    </form>
  )
}

export function AllocationsTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [student, setStudent] = useState<SearchStudent | null>(null)
  const [enrollmentId, setEnrollmentId] = useState('')
  const [showAllocateForm, setShowAllocateForm] = useState(false)

  const current = useApiQuery<{ allocation: AllocationView | null }>(
    ['transport', 'current', enrollmentId],
    `/enrollments/${enrollmentId}/transport`,
    { enabled: !!enrollmentId },
  )
  const history = useApiQuery<{ history: AllocationView[] }>(
    ['transport', 'history', enrollmentId],
    `/enrollments/${enrollmentId}/transport-history`,
    { enabled: !!enrollmentId },
  )

  async function selectStudent(s: SearchStudent) {
    setStudent(s)
    try {
      const res = await apiClient.get<{ data: { enrollment: { id: string } | null } }>(`/students/${s.id}`)
      setEnrollmentId(res.data.data.enrollment?.id ?? '')
      if (!res.data.data.enrollment) show('error', 'This student has no active enrollment')
    } catch (err) {
      show('error', apiErrorMessage(err).message)
    }
  }

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['transport', 'current', enrollmentId] })
    queryClient.invalidateQueries({ queryKey: ['transport', 'history', enrollmentId] })
  }

  const endForm = useForm<{ endDate: string }>({ defaultValues: { endDate: new Date().toISOString().slice(0, 10) } })
  const endAllocation = useMutation({
    mutationFn: async (v: { endDate: string }) => apiClient.post(`/transport-allocations/${current.data?.allocation?.id}/end`, v),
    onSuccess: () => {
      show('success', 'Allocation ended')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <StudentPicker onSelect={selectStudent} />
        {student && (
          <p className="mt-1 text-xs text-ink-muted">
            {student.firstName} {student.lastName ?? ''} ({student.admissionNo})
          </p>
        )}
      </Card>

      {enrollmentId && (
        <>
          <Card className="mb-4 p-4">
            <h3 className="mb-3 text-sm font-semibold text-ink">Current Allocation</h3>
            {current.isLoading ? (
              <PageLoading />
            ) : !current.data?.allocation ? (
              <>
                <EmptyState title="Not currently allocated to any route" />
                {hasPermission('transport.allocate') &&
                  (showAllocateForm ? (
                    <AllocateForm enrollmentId={enrollmentId} onDone={() => { setShowAllocateForm(false); invalidate() }} />
                  ) : (
                    <Button size="sm" onClick={() => setShowAllocateForm(true)}>
                      Allocate to Route
                    </Button>
                  ))}
              </>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-ink">
                    Stop {current.data.allocation.routeStopId} — <Badge tone="success">{current.data.allocation.monthlyFee}/mo</Badge>
                  </p>
                  <p className="text-xs text-ink-subtle">Since {current.data.allocation.startDate}</p>
                </div>
                {hasPermission('transport.allocate') && (
                  <form onSubmit={endForm.handleSubmit((v) => endAllocation.mutate(v))} className="flex flex-wrap items-end gap-2">
                    <Input type="date" {...endForm.register('endDate', { required: true })} />
                    <Button type="submit" variant="danger" size="sm" loading={endAllocation.isPending}>
                      End Allocation
                    </Button>
                  </form>
                )}
              </div>
            )}
          </Card>

          <Card>
            <div className="p-4">
              <h3 className="text-sm font-semibold text-ink">Allocation History</h3>
            </div>
            {history.isLoading ? (
              <PageLoading />
            ) : !history.data || history.data.history.length === 0 ? (
              <EmptyState title="No transport history yet" />
            ) : (
              <Table>
                <Thead>
                  <Tr>
                    <Th>Route Stop</Th>
                    <Th>Monthly Fee</Th>
                    <Th>Start</Th>
                    <Th>End</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {history.data.history.map((h) => (
                    <Tr key={h.id}>
                      <Td>{h.routeStopId}</Td>
                      <Td>{h.monthlyFee}</Td>
                      <Td>{h.startDate}</Td>
                      <Td>{h.endDate ?? '—'}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
