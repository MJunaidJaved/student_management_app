import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import type { AdmissionApplicationView } from './types'

type FormValues = { academicYearId: string; sectionId: string; enrolledOn: string }

export function ConvertDialog({ application, onClose }: { application: AdmissionApplicationView; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { years, sections, currentYear } = useAcademicLookups()
  const sectionsForClass = sections.filter((s) => s.classId === application.appliedClassId)

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { academicYearId: currentYear?.id ?? years[0]?.id ?? '', enrolledOn: new Date().toISOString().slice(0, 10) },
  })

  const convert = useMutation({
    mutationFn: async (v: FormValues) => apiClient.post<{ data: { student: { id: string } } }>(`/applications/${application.id}/convert`, v),
    onSuccess: (res) => {
      show('success', 'Converted to enrolled student')
      queryClient.invalidateQueries({ queryKey: ['admissions'] })
      queryClient.invalidateQueries({ queryKey: ['admissions', application.id] })
      onClose()
      navigate(`/students/${res.data.data.student.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Convert to Enrolled Student" size="sm">
      <form onSubmit={handleSubmit((v) => convert.mutate(v))} className="space-y-4">
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
          <Label>Section</Label>
          <Select {...register('sectionId', { required: true })}>
            <option value="">Select…</option>
            {sectionsForClass.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          {sectionsForClass.length === 0 && <p className="mt-1 text-xs text-ink-muted">No sections exist for this applied class yet.</p>}
        </div>
        <div>
          <Label>Enrolled On</Label>
          <Input type="date" {...register('enrolledOn', { required: true })} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={convert.isPending} disabled={sectionsForClass.length === 0}>
            Convert
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
