import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { StaffView } from './types'

type FormValues = { fullName: string; phone: string; email: string; address: string }

export function StaffEditDialog({ staff, onClose }: { staff: StaffView; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      fullName: staff.fullName,
      phone: staff.phone,
      email: staff.email ?? '',
      address: staff.address ?? '',
    },
  })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === '' ? null : v]))
      await apiClient.patch(`/staff/${staff.id}`, body)
    },
    onSuccess: () => {
      show('success', 'Staff record updated')
      queryClient.invalidateQueries({ queryKey: ['staff', staff.id] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Edit Staff" size="sm">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div>
          <Label>Full Name</Label>
          <Input {...register('fullName')} />
        </div>
        <div>
          <Label>Phone</Label>
          <Input {...register('phone')} />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" {...register('email')} />
        </div>
        <div>
          <Label>Address</Label>
          <Input {...register('address')} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
