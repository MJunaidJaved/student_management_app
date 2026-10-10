import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { BookCategoryView } from './types'

type FormValues = { accessionNo: string; isbn: string; title: string; author: string; categoryId: string; copiesTotal: string; shelfLocation: string }

export function CreateBookDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const categories = useApiQuery<{ categories: BookCategoryView[] }>(['library', 'categories'], '/book-categories')

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) =>
      apiClient.post('/books', {
        accessionNo: v.accessionNo,
        isbn: v.isbn || undefined,
        title: v.title,
        author: v.author || undefined,
        categoryId: v.categoryId || undefined,
        copiesTotal: Number(v.copiesTotal),
        shelfLocation: v.shelfLocation || undefined,
      }),
    onSuccess: () => {
      show('success', 'Book added')
      queryClient.invalidateQueries({ queryKey: ['library', 'books'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Add Book" size="md">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Accession No</Label>
            <Input {...register('accessionNo', { required: true })} />
            <FieldError>{errors.accessionNo && 'Required'}</FieldError>
          </div>
          <div>
            <Label>ISBN (optional)</Label>
            <Input {...register('isbn')} />
          </div>
        </div>
        <div>
          <Label>Title</Label>
          <Input {...register('title', { required: true })} />
          <FieldError>{errors.title && 'Required'}</FieldError>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Author (optional)</Label>
            <Input {...register('author')} />
          </div>
          <div>
            <Label>Category (optional)</Label>
            <Select {...register('categoryId')}>
              <option value="">None</option>
              {categories.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Total Copies</Label>
            <Input type="number" {...register('copiesTotal', { required: true })} />
            <FieldError>{errors.copiesTotal && 'Required'}</FieldError>
          </div>
          <div>
            <Label>Shelf Location (optional)</Label>
            <Input {...register('shelfLocation')} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Add Book
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
