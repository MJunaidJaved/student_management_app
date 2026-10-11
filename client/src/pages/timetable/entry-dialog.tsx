import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { RoomView, SubjectTeacherAssignment, TimetableEntryView } from './types'

type FormValues = { assignmentId: string; roomId: string }

export function EntryDialog({
  sectionId,
  academicYearId,
  dayOfWeek,
  periodId,
  assignments,
  rooms,
  existing,
  onClose,
}: {
  sectionId: string
  academicYearId: string
  dayOfWeek: number
  periodId: string
  assignments: SubjectTeacherAssignment[]
  rooms: RoomView[]
  existing: TimetableEntryView | null
  onClose: () => void
}) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const existingAssignment = existing ? assignments.find((a) => a.subjectId === existing.subjectId && a.staffId === existing.staffId) : undefined

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { assignmentId: existingAssignment?.id ?? '', roomId: existing?.roomId ?? '' },
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['timetable', 'entries', sectionId, academicYearId] })
  }

  const save = useMutation({
    mutationFn: async (v: FormValues) => {
      const assignment = assignments.find((a) => a.id === v.assignmentId)
      if (!assignment) throw new Error('Select a subject / teacher')
      const payload = {
        academicYearId,
        sectionId,
        dayOfWeek,
        periodId,
        subjectId: assignment.subjectId,
        staffId: assignment.staffId,
        roomId: v.roomId || undefined,
      }
      if (existing) {
        await apiClient.patch(`/timetable/entries/${existing.id}`, {
          dayOfWeek: payload.dayOfWeek,
          periodId: payload.periodId,
          subjectId: payload.subjectId,
          staffId: payload.staffId,
          roomId: payload.roomId ?? null,
        })
      } else {
        await apiClient.post('/timetable/entries', payload)
      }
    },
    onSuccess: () => {
      show('success', existing ? 'Entry updated' : 'Entry added')
      invalidate()
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const remove = useMutation({
    mutationFn: async () => apiClient.delete(`/timetable/entries/${existing!.id}`),
    onSuccess: () => {
      show('success', 'Entry removed')
      invalidate()
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title={existing ? 'Edit Period' : 'Add Period'} size="sm">
      <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4">
        <div>
          <Label>Subject / Teacher</Label>
          <Select {...register('assignmentId', { required: true })}>
            <option value="">Select…</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.subjectName} — {a.staffName}
              </option>
            ))}
          </Select>
          {assignments.length === 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              No subject-teacher assignments exist for this section/year yet. Assign one under Academic Setup first.
            </p>
          )}
        </div>
        <div>
          <Label>Room (optional)</Label>
          <Select {...register('roomId')}>
            <option value="">None</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-between gap-2 pt-2">
          {existing ? (
            <Button type="button" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={assignments.length === 0}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
