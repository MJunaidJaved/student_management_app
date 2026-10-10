import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import type { ClassListEntry, ExamScheduleView, MarkView } from './types'

export function MarksEntryPanel({
  schedule,
  academicYearId,
  onClose,
}: {
  schedule: ExamScheduleView
  academicYearId: string
  onClose: () => void
}) {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { sections } = useAcademicLookups()
  const classSections = sections.filter((s) => s.classId === schedule.classId)
  const [sectionId, setSectionId] = useState(classSections[0]?.id ?? '')
  const [rows, setRows] = useState<Record<string, { marks: string; absent: boolean }>>({})
  const canEnter = hasPermission('exams.enter_marks')

  const classList = useApiQuery<{ classList: ClassListEntry[] }>(
    ['exams', 'class-list', sectionId, academicYearId],
    `/sections/${sectionId}/years/${academicYearId}/class-list`,
    { enabled: !!sectionId && !!academicYearId },
  )

  const existingMarks = useApiQuery<{ marks: MarkView[] }>(['exams', 'marks', schedule.id], `/exam-schedules/${schedule.id}/marks`)

  useEffect(() => {
    if (!classList.data || !existingMarks.data) return
    const next: Record<string, { marks: string; absent: boolean }> = {}
    for (const student of classList.data.classList) {
      const mark = existingMarks.data.marks.find((m) => m.enrollmentId === student.id)
      next[student.id] = { marks: mark?.marksObtained ?? '', absent: mark?.isAbsent ?? false }
    }
    setRows(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classList.data, existingMarks.data])

  const submit = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(rows).map(([enrollmentId, v]) => ({
        enrollmentId,
        marksObtained: v.absent ? undefined : v.marks || undefined,
        isAbsent: v.absent,
      }))
      await apiClient.post('/marks/submit', { examScheduleId: schedule.id, entries })
    },
    onSuccess: () => {
      show('success', 'Marks saved')
      queryClient.invalidateQueries({ queryKey: ['exams', 'marks', schedule.id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  function setMark(enrollmentId: string, patch: Partial<{ marks: string; absent: boolean }>) {
    setRows((r) => ({ ...r, [enrollmentId]: { marks: r[enrollmentId]?.marks ?? '', absent: r[enrollmentId]?.absent ?? false, ...patch } }))
  }

  return (
    <Card className="mt-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">Enter Marks (out of {schedule.totalMarks})</h4>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {classSections.length > 1 && (
        <div className="mb-3">
          <Select className="w-52" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
            {classSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {classList.isLoading || existingMarks.isLoading ? (
        <PageLoading />
      ) : !classList.data || classList.data.classList.length === 0 ? (
        <EmptyState title="No students enrolled in this section" />
      ) : (
        <>
          <Table>
            <Thead>
              <Tr>
                <Th>Roll No</Th>
                <Th>Name</Th>
                <Th>Marks</Th>
                <Th>Absent</Th>
              </Tr>
            </Thead>
            <Tbody>
              {classList.data.classList.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.rollNo}</Td>
                  <Td>
                    {s.firstName} {s.lastName ?? ''}
                  </Td>
                  <Td>
                    <Input
                      type="number"
                      step="0.01"
                      className="w-24"
                      disabled={!canEnter || (rows[s.id]?.absent ?? false)}
                      value={rows[s.id]?.marks ?? ''}
                      onChange={(e) => setMark(s.id, { marks: e.target.value })}
                    />
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      disabled={!canEnter}
                      checked={rows[s.id]?.absent ?? false}
                      onChange={(e) => setMark(s.id, { absent: e.target.checked })}
                    />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          {canEnter && (
            <div className="mt-3 flex justify-end">
              <Button loading={submit.isPending} onClick={() => submit.mutate()}>
                Save Marks
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
