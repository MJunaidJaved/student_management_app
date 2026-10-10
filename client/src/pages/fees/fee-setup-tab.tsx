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
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import type { FeeCategoryView, FeeStructureView, DiscountView } from './types'

function CategoriesCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const categories = useApiQuery<{ categories: FeeCategoryView[] }>(['fees', 'categories'], '/fee-categories')
  const { register, handleSubmit, reset } = useForm<{ name: string; frequency: string }>({ defaultValues: { frequency: 'monthly' } })

  const create = useMutation({
    mutationFn: async (v: { name: string; frequency: string }) => apiClient.post('/fee-categories', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['fees', 'categories'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      apiClient.post(`/fee-categories/${id}/${active ? 'activate' : 'deactivate'}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fees', 'categories'] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Fee Categories</h3>
      {hasPermission('fees.manage_structures') && (
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1">
            <Label>Name</Label>
            <Input placeholder="Tuition Fee" {...register('name', { required: true })} />
          </div>
          <div>
            <Label>Frequency</Label>
            <Select {...register('frequency')}>
              <option value="monthly">Monthly</option>
              <option value="termly">Termly</option>
              <option value="yearly">Yearly</option>
              <option value="one_time">One-time</option>
            </Select>
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>
      )}
      {categories.isLoading ? (
        <PageLoading />
      ) : !categories.data || categories.data.categories.length === 0 ? (
        <EmptyState title="No fee categories yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Frequency</Th>
              <Th>Status</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {categories.data.categories.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium text-ink">{c.name}</Td>
                <Td className="capitalize">{c.frequency.replace('_', '-')}</Td>
                <Td>
                  <Badge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Active' : 'Inactive'}</Badge>
                </Td>
                <Td>
                  {hasPermission('fees.manage_structures') && (
                    <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate({ id: c.id, active: !c.isActive })}>
                      {c.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  )}
                </Td>
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
  const { years, classes, currentYear } = useAcademicLookups()
  const categories = useApiQuery<{ categories: FeeCategoryView[] }>(['fees', 'categories'], '/fee-categories')

  const { register, handleSubmit, reset, watch } = useForm<{ academicYearId: string; classId: string; feeCategoryId: string; amount: string }>({
    defaultValues: { academicYearId: currentYear?.id ?? years[0]?.id ?? '' },
  })
  const watchedYear = watch('academicYearId') || currentYear?.id || years[0]?.id || ''

  const structures = useApiQuery<{ structures: FeeStructureView[] }>(
    ['fees', 'structures', watchedYear],
    `/fee-structures?academicYearId=${watchedYear}`,
    { enabled: !!watchedYear },
  )

  const create = useMutation({
    mutationFn: async (v: { academicYearId: string; classId: string; feeCategoryId: string; amount: string }) =>
      apiClient.post('/fee-structures', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['fees', 'structures'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Fee Structures</h3>
      {hasPermission('fees.manage_structures') && (
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <Label>Year</Label>
            <Select {...register('academicYearId', { required: true })}>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Class</Label>
            <Select {...register('classId', { required: true })}>
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select {...register('feeCategoryId', { required: true })}>
              <option value="">Select…</option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Amount</Label>
            <Input type="number" step="0.01" className="w-28" {...register('amount', { required: true })} />
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>
      )}
      {structures.isLoading ? (
        <PageLoading />
      ) : !structures.data || structures.data.structures.length === 0 ? (
        <EmptyState title="No fee structures for this year yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Class</Th>
              <Th>Category</Th>
              <Th>Amount</Th>
            </Tr>
          </Thead>
          <Tbody>
            {structures.data.structures.map((s) => (
              <Tr key={s.id}>
                <Td>{classes.find((c) => c.id === s.classId)?.name ?? s.classId}</Td>
                <Td>{categories.data?.categories.find((c) => c.id === s.feeCategoryId)?.name ?? s.feeCategoryId}</Td>
                <Td>{Number(s.amount).toLocaleString()}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

function DiscountsCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const discounts = useApiQuery<{ discounts: DiscountView[] }>(['fees', 'discounts'], '/discounts', {
    enabled: hasPermission('fees.manage_discounts'),
  })
  const { register, handleSubmit, reset } = useForm<{ name: string; type: string; value: string }>({ defaultValues: { type: 'fixed' } })

  const create = useMutation({
    mutationFn: async (v: { name: string; type: string; value: string }) => apiClient.post('/discounts', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['fees', 'discounts'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('fees.manage_discounts')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Discounts</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="Sibling Discount" {...register('name', { required: true })} />
        </div>
        <div>
          <Label>Type</Label>
          <Select {...register('type')}>
            <option value="fixed">Fixed</option>
            <option value="percent">Percent</option>
          </Select>
        </div>
        <div>
          <Label>Value</Label>
          <Input type="number" step="0.01" className="w-28" {...register('value', { required: true })} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>
      {discounts.isLoading ? (
        <PageLoading />
      ) : !discounts.data || discounts.data.discounts.length === 0 ? (
        <EmptyState title="No discounts defined yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Value</Th>
            </Tr>
          </Thead>
          <Tbody>
            {discounts.data.discounts.map((d) => (
              <Tr key={d.id}>
                <Td className="font-medium text-ink">{d.name}</Td>
                <Td className="capitalize">{d.type}</Td>
                <Td>{d.value}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

export function FeeSetupTab() {
  return (
    <div className="space-y-4">
      <CategoriesCard />
      <StructuresCard />
      <DiscountsCard />
    </div>
  )
}
