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
import type { BookCategoryView } from './types'

export function LibrarySetupTab() {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const categories = useApiQuery<{ categories: BookCategoryView[] }>(['library', 'categories'], '/book-categories')
  const { register, handleSubmit, reset } = useForm<{ name: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string }) => apiClient.post('/book-categories', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['library', 'categories'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Book Categories</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <Label>Name</Label>
          <Input placeholder="Fiction" {...register('name', { required: true })} />
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
