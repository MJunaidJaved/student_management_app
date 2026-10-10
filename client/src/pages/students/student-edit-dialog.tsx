import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { StudentView } from './types'

type FormValues = {
  firstName: string
  lastName: string
  phone: string
  address: string
  bloodGroup: string
  religion: string
  previousSchool: string
}

export function StudentEditDialog({ student, onClose }: { student: StudentView; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      firstName: student.firstName,
      lastName: student.lastName ?? '',
      phone: student.phone ?? '',
      address: student.address ?? '',
      bloodGroup: student.bloodGroup ?? '',
      religion: student.religion ?? '',
      previousSchool: student.previousSchool ?? '',
    },
  })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === '' ? null : v]))
      await apiClient.patch(`/students/${student.id}`, body)
    },
    onSuccess: () => {
      show('success', 'Student record updated')
      queryClient.invalidateQueries({ queryKey: ['students', student.id] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Edit Student" size="md">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>First Name</Label>
            <Input {...register('firstName')} />
          </div>
          <div>
            <Label>Last Name</Label>
            <Input {...register('lastName')} />
          </div>
        </div>
        <div>
          <Label>Phone</Label>
          <Input {...register('phone')} />
        </div>
        <div>
          <Label>Address</Label>
          <Input {...register('address')} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label>Blood Group</Label>
            <Select {...register('bloodGroup')}>
              <option value="">—</option>
              {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Religion</Label>
            <Input {...register('religion')} />
          </div>
          <div>
            <Label>Previous School</Label>
            <Input {...register('previousSchool')} />
          </div>
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
