import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type FormValues = { name: string; description: string }

export function CreateRoleDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) => apiClient.post('/roles', { name: v.name, description: v.description || undefined }),
    onSuccess: () => {
      show('success', 'Role created')
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Role" size="sm">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input {...register('name', { required: true })} />
          <FieldError>{errors.name && 'Name is required'}</FieldError>
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Input {...register('description')} />
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
