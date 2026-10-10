import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useApiQuery } from '@/hooks/use-api-query'
import type { RoomView } from '@/pages/timetable/types'

type FormValues = {
  classId: string
  subjectId: string
  examDate: string
  startTime: string
  endTime: string
  roomId: string
  totalMarks: string
  passingMarks: string
}

export function ScheduleDialog({ examId, onClose }: { examId: string; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { classes } = useAcademicLookups()
  const rooms = useApiQuery<{ rooms: RoomView[] }>(['timetable', 'rooms'], '/academic/rooms')

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>()
  const classId = watch('classId')

  const subjects = useApiQuery<{ subjects: { id: string; subjectId: string; subjectName: string }[] }>(
    ['academic', 'class-subjects', classId],
    `/academic/classes/${classId}/subjects`,
    { enabled: !!classId },
  )

  const create = useMutation({
    mutationFn: async (v: FormValues) =>
      apiClient.post('/exam-schedules', {
        examId,
        classId: v.classId,
        subjectId: v.subjectId,
        examDate: v.examDate,
        startTime: v.startTime,
        endTime: v.endTime,
        roomId: v.roomId || undefined,
        totalMarks: v.totalMarks,
        passingMarks: v.passingMarks,
      }),
    onSuccess: () => {
      show('success', 'Schedule added')
      queryClient.invalidateQueries({ queryKey: ['exams', 'schedules', examId] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Schedule Exam Paper" size="md">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Class</Label>
            <Select {...register('classId', { required: true })}>
              <option value="">Select…</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Subject</Label>
            <Select {...register('subjectId', { required: true })} disabled={!classId}>
              <option value="">Select…</option>
              {subjects.data?.subjects.map((s) => (
                <option key={s.id} value={s.subjectId}>
                  {s.subjectName}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div>
          <Label>Date</Label>
          <Input type="date" {...register('examDate', { required: true })} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Start Time</Label>
            <Input type="time" {...register('startTime', { required: true })} />
          </div>
          <div>
            <Label>End Time</Label>
            <Input type="time" {...register('endTime', { required: true })} />
          </div>
        </div>

        <div>
          <Label>Room (optional)</Label>
          <Select {...register('roomId')}>
            <option value="">None</option>
            {rooms.data?.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Total Marks</Label>
            <Input type="number" step="0.01" {...register('totalMarks', { required: true })} />
            <FieldError>{errors.totalMarks && 'Required'}</FieldError>
          </div>
          <div>
            <Label>Passing Marks</Label>
            <Input type="number" step="0.01" {...register('passingMarks', { required: true })} />
            <FieldError>{errors.passingMarks && 'Required'}</FieldError>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Add Schedule
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
