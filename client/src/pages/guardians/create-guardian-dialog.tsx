import { useForm } from 'react-hook-form'
import { useMutation } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type FormValues = { fullName: string; phone: string; nationalId: string; email: string; occupation: string; address: string }

export function CreateGuardianDialog({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const { show } = useToast()
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) =>
      apiClient.post<{ data: { id: string } }>('/guardians', {
        fullName: v.fullName,
        phone: v.phone,
        nationalId: v.nationalId || undefined,
        email: v.email || undefined,
        occupation: v.occupation || undefined,
        address: v.address || undefined,
      }),
    onSuccess: (res) => {
      show('success', 'Guardian created')
      onCreated(res.data.data.id)
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Guardian" size="sm">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div>
          <Label>Full Name</Label>
          <Input {...register('fullName', { required: true })} />
          <FieldError>{errors.fullName && 'Required'}</FieldError>
        </div>
        <div>
          <Label>Phone</Label>
          <Input {...register('phone', { required: true })} />
          <FieldError>{errors.phone && 'Required'}</FieldError>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>National ID (optional)</Label>
            <Input {...register('nationalId')} />
          </div>
          <div>
            <Label>Email (optional)</Label>
            <Input type="email" {...register('email')} />
          </div>
        </div>
        <div>
          <Label>Occupation (optional)</Label>
          <Input {...register('occupation')} />
        </div>
        <div>
          <Label>Address (optional)</Label>
          <Input {...register('address')} />
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
