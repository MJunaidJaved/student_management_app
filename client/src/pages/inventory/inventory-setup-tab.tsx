import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { ItemCategoryView, SupplierView } from './types'

function CategoriesCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const categories = useApiQuery<{ categories: ItemCategoryView[] }>(['inventory', 'categories'], '/item-categories')
  const { register, handleSubmit, reset } = useForm<{ name: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string }) => apiClient.post('/item-categories', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['inventory', 'categories'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('inventory.manage_items')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Item Categories</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="Stationery" {...register('name', { required: true })} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>
      {categories.isLoading ? (
        <PageLoading />
      ) : !categories.data || categories.data.categories.length === 0 ? (
        <EmptyState title="No categories yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
            </Tr>
          </Thead>
          <Tbody>
            {categories.data.categories.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium text-ink">{c.name}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

function SuppliersCard() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const suppliers = useApiQuery<{ suppliers: SupplierView[] }>(['inventory', 'suppliers'], '/suppliers')
  const { register, handleSubmit, reset } = useForm<{ name: string; phone: string; email: string; address: string; taxNo: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string; phone: string; email: string; address: string; taxNo: string }) =>
      apiClient.post('/suppliers', {
        name: v.name,
        phone: v.phone || undefined,
        email: v.email || undefined,
        address: v.address || undefined,
        taxNo: v.taxNo || undefined,
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['inventory', 'suppliers'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (!hasPermission('inventory.manage_suppliers')) return null

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Suppliers</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input {...register('name', { required: true })} />
        </div>
        <div>
          <Label>Phone</Label>
          <Input {...register('phone')} />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" {...register('email')} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>
      {suppliers.isLoading ? (
        <PageLoading />
      ) : !suppliers.data || suppliers.data.suppliers.length === 0 ? (
        <EmptyState title="No suppliers yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Email</Th>
            </Tr>
          </Thead>
          <Tbody>
            {suppliers.data.suppliers.map((s) => (
              <Tr key={s.id}>
                <Td className="font-medium text-ink">{s.name}</Td>
                <Td>{s.phone ?? '—'}</Td>
                <Td>{s.email ?? '—'}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

export function InventorySetupTab() {
  return (
    <div className="space-y-4">
      <CategoriesCard />
      <SuppliersCard />
    </div>
  )
}
