import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { EntitySearchBox } from '@/components/entity-search-box'
import type { LeaveTypeView, StaffLeaveBalanceView } from './types'

function LeaveTypesCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const leaveTypes = useApiQuery<{ leaveTypes: LeaveTypeView[] }>(['leave', 'types'], '/leave-types')
  const { register, handleSubmit, reset } = useForm<{ name: string; appliesTo: string; daysPerYear: string }>({
    defaultValues: { appliesTo: 'both' },
  })

  const create = useMutation({
    mutationFn: async (v: { name: string; appliesTo: string; daysPerYear: string }) =>
      apiClient.post('/leave-types', { name: v.name, appliesTo: v.appliesTo, daysPerYear: v.daysPerYear ? Number(v.daysPerYear) : undefined }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['leave', 'types'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/leave-types/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leave', 'types'] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('leave.manage_types')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Leave Types</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="Sick Leave" {...register('name', { required: true })} />
        </div>
        <div>
          <Label>Applies To</Label>
          <Select {...register('appliesTo')}>
            <option value="both">Both</option>
            <option value="student">Student</option>
            <option value="staff">Staff</option>
          </Select>
        </div>
        <div>
          <Label>Days / Year</Label>
          <Input type="number" className="w-28" {...register('daysPerYear')} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      {leaveTypes.isLoading ? (
        <PageLoading />
      ) : !leaveTypes.data || leaveTypes.data.leaveTypes.length === 0 ? (
        <EmptyState title="No leave types defined yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Applies To</Th>
              <Th>Days / Year</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {leaveTypes.data.leaveTypes.map((t) => (
              <Tr key={t.id}>
                <Td className="font-medium text-ink">{t.name}</Td>
                <Td className="capitalize">{t.appliesTo}</Td>
                <Td>{t.daysPerYear ?? '—'}</Td>
                <Td>
                  <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(t.id)}>
                    Delete
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

type SearchStaff = { id: string; employeeNo: string; fullName: string }

function StaffBalancesCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { currentYear } = useAcademicLookups()
  const leaveTypes = useApiQuery<{ leaveTypes: LeaveTypeView[] }>(['leave', 'types'], '/leave-types')
  const staffLeaveTypes = (leaveTypes.data?.leaveTypes ?? []).filter((t) => t.appliesTo === 'staff' || t.appliesTo === 'both')

  const [staff, setStaff] = useState<SearchStaff | null>(null)
  const { register, handleSubmit, reset } = useForm<{ leaveTypeId: string; allotted: string }>()

  const balances = useApiQuery<{ balances: StaffLeaveBalanceView[] }>(
    ['leave', 'balances', staff?.id],
    `/staff/${staff?.id}/leave-balances`,
    { enabled: !!staff },
  )

  const set = useMutation({
    mutationFn: async (v: { leaveTypeId: string; allotted: string }) =>
      apiClient.post('/staff-leave-balances', {
        staffId: staff!.id,
        leaveTypeId: v.leaveTypeId,
        academicYearId: currentYear?.id,
        allotted: Number(v.allotted),
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['leave', 'balances', staff?.id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('leave.manage_balances')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Staff Leave Balances</h3>
      <div className="mb-3">
        <EntitySearchBox<SearchStaff>
          endpoint="/staff-search"
          resultsKey="staff"
          placeholder="Search by employee no, name, or phone…"
          onSelect={setStaff}
          renderResult={(s) => (
            <div className="flex items-center justify-between">
              <span className="text-ink">{s.fullName}</span>
              <span className="text-xs text-ink-subtle">{s.employeeNo}</span>
            </div>
          )}
        />
        {staff && <p className="mt-1 text-xs text-ink-muted">{staff.fullName} ({staff.employeeNo})</p>}
      </div>

      {staff && (
        <>
          <form onSubmit={handleSubmit((v) => set.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <Label>Leave Type</Label>
              <Select {...register('leaveTypeId', { required: true })}>
                <option value="">Select…</option>
                {staffLeaveTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Allotted Days</Label>
              <Input type="number" className="w-28" {...register('allotted', { required: true })} />
            </div>
            <Button type="submit" loading={set.isPending} disabled={!currentYear}>
              Set
            </Button>
          </form>

          {balances.isLoading ? (
            <PageLoading />
          ) : !balances.data || balances.data.balances.length === 0 ? (
            <EmptyState title="No balances set for this staff member" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Leave Type</Th>
                  <Th>Allotted</Th>
                  <Th>Used</Th>
                </Tr>
              </Thead>
              <Tbody>
                {balances.data.balances.map((b) => (
                  <Tr key={b.id}>
                    <Td>{b.leaveTypeName}</Td>
                    <Td>{b.allotted}</Td>
                    <Td>{b.used}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </>
      )}
    </Card>
  )
}

export function LeaveSetupTab() {
  return (
    <div className="space-y-4">
      <LeaveTypesCard />
      <StaffBalancesCard />
    </div>
  )
}
