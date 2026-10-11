import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { StaffPicker, type PickableStaff } from '@/components/staff-picker'
import type { PeriodView, TimetableEntryView } from './types'
import { DAY_NAMES } from './types'

type SearchStaff = PickableStaff
type FormValues = { subDate: string; timetableEntryId: string; reason: string }

export function AssignSubstitutionDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { years, sections, currentYear } = useAcademicLookups()
  const [yearId, setYearId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [substitute, setSubstitute] = useState<SearchStaff | null>(null)

  const effectiveYear = yearId || currentYear?.id || years[0]?.id || ''
  const periods = useApiQuery<{ periods: PeriodView[] }>(['timetable', 'periods'], '/periods')
  const entries = useApiQuery<{ entries: TimetableEntryView[] }>(
    ['timetable', 'entries', sectionId, effectiveYear],
    `/timetable/sections/${sectionId}/years/${effectiveYear}`,
    { enabled: !!sectionId && !!effectiveYear },
  )

  const periodName = (id: string) => periods.data?.periods.find((p) => p.id === id)?.name ?? id

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { subDate: new Date().toISOString().slice(0, 10) },
  })

  const submit = useMutation({
    mutationFn: async (v: FormValues) => {
      if (!substitute) throw new Error('Select a substitute teacher')
      await apiClient.post('/substitutions', {
        timetableEntryId: v.timetableEntryId,
        subDate: v.subDate,
        substituteStaffId: substitute.id,
        reason: v.reason || undefined,
      })
    },
    onSuccess: () => {
      show('success', 'Substitute assigned')
      queryClient.invalidateQueries({ queryKey: ['substitutions'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Assign Substitute" size="md">
      <form onSubmit={handleSubmit((v) => submit.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Academic Year</Label>
            <Select value={effectiveYear} onChange={(e) => setYearId(e.target.value)}>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Section</Label>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">Select…</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.className} - {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label>Scheduled Class</Label>
          <Select {...register('timetableEntryId', { required: true })} disabled={!entries.data?.entries.length}>
            <option value="">Select…</option>
            {(entries.data?.entries ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {DAY_NAMES[e.dayOfWeek]} — {periodName(e.periodId)}
              </option>
            ))}
          </Select>
          {sectionId && entries.data && entries.data.entries.length === 0 && (
            <p className="mt-1 text-xs text-ink-muted">This section has no scheduled periods for this year.</p>
          )}
        </div>

        <div>
          <Label>Substitute Teacher</Label>
          <StaffPicker onSelect={setSubstitute} />
          {substitute && (
            <p className="mt-1 text-xs text-ink-muted">
              {substitute.fullName} ({substitute.employeeNo})
            </p>
          )}
        </div>

        <div>
          <Label>Date</Label>
          <Input type="date" {...register('subDate', { required: true })} />
        </div>

        <div>
          <Label>Reason (optional)</Label>
          <Input {...register('reason')} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submit.isPending} disabled={!substitute}>
            Assign
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
