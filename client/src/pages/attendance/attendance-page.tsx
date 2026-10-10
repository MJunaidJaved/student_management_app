import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'

type SheetRow = { enrollmentId: string; rollNo: number; firstName: string; lastName: string | null; admissionNo: string; status: string | null; remarks: string | null }
type Status = 'present' | 'absent' | 'late' | 'leave'
const STATUSES: Status[] = ['present', 'absent', 'late', 'leave']

const statusColor: Record<Status, string> = {
  present: 'bg-success-50 text-success-600 border-success-500/30',
  absent: 'bg-danger-50 text-danger-600 border-danger-500/30',
  late: 'bg-warning-50 text-warning-600 border-warning-500/30',
  leave: 'bg-info-50 text-info-600 border-info-500/30',
}

export function AttendancePage() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { years, sections, currentYear } = useAcademicLookups()

  const [yearId, setYearId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [edits, setEdits] = useState<Record<string, Status>>({})

  const effectiveYear = yearId || currentYear?.id || years[0]?.id || ''

  const sheetQuery = useQuery({
    queryKey: ['attendance', 'sheet', sectionId, effectiveYear, date],
    queryFn: async () => {
      const res = await apiClient.get<{ data: { sheet: SheetRow[] } }>(
        `/attendance/students/sections/${sectionId}/years/${effectiveYear}`,
        { params: { date } },
      )
      return res.data.data.sheet
    },
    enabled: !!sectionId && !!effectiveYear,
  })

  const submit = useMutation({
    mutationFn: async () => {
      const entries = Object.entries(edits).map(([enrollmentId, status]) => ({ enrollmentId, status }))
      if (entries.length === 0) throw new Error('No changes to submit')
      await apiClient.post('/attendance/students/submit', {
        sectionId,
        academicYearId: effectiveYear,
        date,
        reason: 'Marked via portal',
        entries,
      })
    },
    onSuccess: () => {
      show('success', 'Attendance saved')
      setEdits({})
      queryClient.invalidateQueries({ queryKey: ['attendance', 'sheet', sectionId, effectiveYear, date] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const rows = useMemo(() => sheetQuery.data ?? [], [sheetQuery.data])
  const dirtyCount = Object.keys(edits).length

  function setStatus(enrollmentId: string, status: Status) {
    setEdits((e) => ({ ...e, [enrollmentId]: status }))
  }
  function markAll(status: Status) {
    const next: Record<string, Status> = {}
    for (const r of rows) next[r.enrollmentId] = status
    setEdits(next)
  }

  return (
    <RequirePermission anyOf={['attendance.read']}>
      <div>
        <PageHeader title="Student Attendance" description="Mark or review a section's daily attendance." />

        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Academic Year</label>
              <Select className="w-44" value={effectiveYear} onChange={(e) => setYearId(e.target.value)}>
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Section</label>
              <Select className="w-52" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
                <option value="">Select section…</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.className} - {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Date</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            {hasPermission('attendance.mark') && rows.length > 0 && (
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => markAll('present')}>
                  Mark all present
                </Button>
                <Button size="sm" loading={submit.isPending} disabled={dirtyCount === 0} onClick={() => submit.mutate()}>
                  <CalendarCheck className="size-4" />
                  Save {dirtyCount > 0 && `(${dirtyCount})`}
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card>
          {!sectionId ? (
            <EmptyState title="Select a section to view its attendance sheet" />
          ) : sheetQuery.isLoading ? (
            <PageLoading />
          ) : rows.length === 0 ? (
            <EmptyState title="No students enrolled in this section" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Roll No</Th>
                  <Th>Name</Th>
                  <Th>Admission No</Th>
                  <Th>Status</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rows.map((r) => {
                  const current = (edits[r.enrollmentId] ?? r.status ?? 'present') as Status
                  return (
                    <Tr key={r.enrollmentId}>
                      <Td>{r.rollNo}</Td>
                      <Td>
                        {r.firstName} {r.lastName ?? ''}
                      </Td>
                      <Td>{r.admissionNo}</Td>
                      <Td>
                        <div className="flex gap-1">
                          {STATUSES.map((s) => (
                            <button
                              key={s}
                              disabled={!hasPermission('attendance.mark')}
                              onClick={() => setStatus(r.enrollmentId, s)}
                              className={cn(
                                'rounded-md border px-2 py-1 text-xs font-medium capitalize transition-colors disabled:opacity-50',
                                current === s ? statusColor[s] : 'border-border text-ink-subtle hover:bg-surface-muted',
                              )}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          )}
        </Card>
      </div>
    </RequirePermission>
  )
}
