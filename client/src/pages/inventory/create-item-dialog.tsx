import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { ItemCategoryView } from './types'

type FormValues = { sku: string; name: string; categoryId: string; unit: string; reorderLevel: string }

export function CreateItemDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const categories = useApiQuery<{ categories: ItemCategoryView[] }>(['inventory', 'categories'], '/item-categories')

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) => apiClient.post('/items', v),
    onSuccess: () => {
      show('success', 'Item created')
      queryClient.invalidateQueries({ queryKey: ['inventory', 'items'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Item" size="sm">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div>
          <Label>SKU</Label>
          <Input {...register('sku', { required: true })} />
          <FieldError>{errors.sku && 'SKU is required'}</FieldError>
        </div>
        <div>
          <Label>Name</Label>
          <Input {...register('name', { required: true })} />
          <FieldError>{errors.name && 'Name is required'}</FieldError>
        </div>
        <div>
          <Label>Category</Label>
          <Select {...register('categoryId', { required: true })}>
            <option value="">Select…</option>
            {categories.data?.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <FieldError>{errors.categoryId && 'Category is required'}</FieldError>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Unit</Label>
            <Input placeholder="pcs" {...register('unit', { required: true })} />
          </div>
          <div>
            <Label>Reorder Level</Label>
            <Input type="number" step="0.01" {...register('reorderLevel', { required: true })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
