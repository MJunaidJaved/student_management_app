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
import { StaffPicker, type PickableStaff } from '@/components/staff-picker'
import type { SalaryComponentView, SalaryStructureView, StaffSalaryView } from './types'

function ComponentsCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const components = useApiQuery<{ components: SalaryComponentView[] }>(['payroll', 'components'], '/salary-components')
  const { register, handleSubmit, reset } = useForm<{ name: string; type: string; calcType: string }>({
    defaultValues: { type: 'earning', calcType: 'fixed' },
  })

  const create = useMutation({
    mutationFn: async (v: { name: string; type: string; calcType: string }) => apiClient.post('/salary-components', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['payroll', 'components'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('payroll.manage_structures')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Salary Components</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="House Rent Allowance" {...register('name', { required: true })} />
        </div>
        <div>
          <Label>Type</Label>
          <Select {...register('type')}>
            <option value="earning">Earning</option>
            <option value="deduction">Deduction</option>
          </Select>
        </div>
        <div>
          <Label>Calc Type</Label>
          <Select {...register('calcType')}>
            <option value="fixed">Fixed</option>
            <option value="percent">Percent</option>
          </Select>
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      {components.isLoading ? (
        <PageLoading />
      ) : !components.data || components.data.components.length === 0 ? (
        <EmptyState title="No salary components yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Calc Type</Th>
            </Tr>
          </Thead>
          <Tbody>
            {components.data.components.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium text-ink">{c.name}</Td>
                <Td className="capitalize">{c.type}</Td>
                <Td className="capitalize">{c.calcType}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

function StructuresCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const structures = useApiQuery<{ structures: SalaryStructureView[] }>(['payroll', 'structures'], '/salary-structures')
  const { register, handleSubmit, reset } = useForm<{ name: string; description: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string; description: string }) => apiClient.post('/salary-structures', { name: v.name, description: v.description || undefined }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['payroll', 'structures'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('payroll.manage_structures')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Salary Structures</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="Teaching Staff" {...register('name', { required: true })} />
        </div>
        <div className="min-w-[160px] flex-1">
          <Label>Description (optional)</Label>
          <Input {...register('description')} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      {structures.isLoading ? (
        <PageLoading />
      ) : !structures.data || structures.data.structures.length === 0 ? (
        <EmptyState title="No salary structures yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Description</Th>
            </Tr>
          </Thead>
          <Tbody>
            {structures.data.structures.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium text-ink">{s.name}</Td>
                <Td>{s.description ?? '—'}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

type SearchStaff = PickableStaff

function StaffSalaryCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const structures = useApiQuery<{ structures: SalaryStructureView[] }>(['payroll', 'structures'], '/salary-structures')
  const [staff, setStaff] = useState<SearchStaff | null>(null)
  const { register, handleSubmit, reset } = useForm<{ salaryStructureId: string; basicSalary: string; effectiveFrom: string }>()

  const history = useApiQuery<{ history: StaffSalaryView[] }>(['payroll', 'salary-history', staff?.id], `/staff/${staff?.id}/salary-history`, {
    enabled: !!staff,
  })

  const assign = useMutation({
    mutationFn: async (v: { salaryStructureId: string; basicSalary: string; effectiveFrom: string }) =>
      apiClient.post('/staff-salaries', {
        staffId: staff!.id,
        salaryStructureId: v.salaryStructureId || undefined,
        basicSalary: v.basicSalary,
        effectiveFrom: v.effectiveFrom,
      }),
    onSuccess: () => {
      reset()
      show('success', 'Salary assigned')
      queryClient.invalidateQueries({ queryKey: ['payroll', 'salary-history', staff?.id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('payroll.manage_salaries')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Staff Salary</h3>
      <StaffPicker onSelect={setStaff} />
      {staff && (
        <>
          <p className="mt-1 mb-3 text-xs text-ink-muted">
            {staff.fullName} ({staff.employeeNo})
          </p>
          <form onSubmit={handleSubmit((v) => assign.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
            <div>
              <Label>Structure (optional)</Label>
              <Select {...register('salaryStructureId')}>
                <option value="">None</option>
                {structures.data?.structures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Basic Salary</Label>
              <Input type="number" step="0.01" className="w-32" {...register('basicSalary', { required: true })} />
            </div>
            <div>
              <Label>Effective From</Label>
              <Input type="date" {...register('effectiveFrom', { required: true })} />
            </div>
            <Button type="submit" loading={assign.isPending}>
              Assign
            </Button>
          </form>

          {history.isLoading ? (
            <PageLoading />
          ) : !history.data || history.data.history.length === 0 ? (
            <EmptyState title="No salary history yet" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Basic Salary</Th>
                  <Th>Effective From</Th>
                  <Th>Effective To</Th>
                </Tr>
              </Thead>
              <Tbody>
                {history.data.history.map((h) => (
                  <Tr key={h.id}>
                    <Td>{h.basicSalary}</Td>
                    <Td>{h.effectiveFrom}</Td>
                    <Td>{h.effectiveTo ?? '—'}</Td>
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

export function SalarySetupTab() {
  return (
    <div className="space-y-4">
      <ComponentsCard />
      <StructuresCard />
      <StaffSalaryCard />
    </div>
  )
}
