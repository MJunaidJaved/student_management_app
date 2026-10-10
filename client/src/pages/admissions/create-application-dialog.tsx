import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'

type FormValues = { applicantName: string; dob: string; gender: string; guardianName: string; guardianPhone: string; appliedClassId: string; remarks: string }

export function CreateApplicationDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { classes } = useAcademicLookups()

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) =>
      apiClient.post('/applications', {
        applicantName: v.applicantName,
        dob: v.dob,
        gender: v.gender || undefined,
        guardianName: v.guardianName,
        guardianPhone: v.guardianPhone,
        appliedClassId: v.appliedClassId,
        remarks: v.remarks || undefined,
      }),
    onSuccess: () => {
      show('success', 'Application recorded')
      queryClient.invalidateQueries({ queryKey: ['admissions'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Admission Enquiry" size="md">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div>
          <Label>Applicant Name</Label>
          <Input {...register('applicantName', { required: true })} />
          <FieldError>{errors.applicantName && 'Required'}</FieldError>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Date of Birth</Label>
            <Input type="date" {...register('dob', { required: true })} />
          </div>
          <div>
            <Label>Gender (optional)</Label>
            <Select {...register('gender')}>
              <option value="">Unspecified</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Guardian Name</Label>
            <Input {...register('guardianName', { required: true })} />
          </div>
          <div>
            <Label>Guardian Phone</Label>
            <Input {...register('guardianPhone', { required: true })} />
          </div>
        </div>
        <div>
          <Label>Applied Class</Label>
          <Select {...register('appliedClassId', { required: true })}>
            <option value="">Select…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <FieldError>{errors.appliedClassId && 'Required'}</FieldError>
        </div>
        <div>
          <Label>Remarks (optional)</Label>
          <Input {...register('remarks')} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Record
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
