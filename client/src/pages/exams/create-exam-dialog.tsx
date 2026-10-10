import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import type { ExamTypeView } from './types'

type FormValues = { academicYearId: string; examTypeId: string; name: string; startDate: string; endDate: string }

export function CreateExamDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { years, currentYear } = useAcademicLookups()
  const types = useApiQuery<{ types: ExamTypeView[] }>(['exams', 'types'], '/exam-types')

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: { academicYearId: currentYear?.id ?? years[0]?.id ?? '' } })

  const create = useMutation({
    mutationFn: async (v: FormValues) => apiClient.post('/exams', v),
    onSuccess: () => {
      show('success', 'Exam created')
      queryClient.invalidateQueries({ queryKey: ['exams'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Exam" size="sm">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input placeholder="Mid-Term 2026" {...register('name', { required: true })} />
          <FieldError>{errors.name && 'Name is required'}</FieldError>
        </div>
        <div>
          <Label>Academic Year</Label>
          <Select {...register('academicYearId', { required: true })}>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Exam Type</Label>
          <Select {...register('examTypeId', { required: true })}>
            <option value="">Select…</option>
            {types.data?.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <FieldError>{errors.examTypeId && 'Exam type is required'}</FieldError>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Start Date</Label>
            <Input type="date" {...register('startDate', { required: true })} />
          </div>
          <div>
            <Label>End Date</Label>
            <Input type="date" {...register('endDate', { required: true })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create Draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
