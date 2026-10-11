import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Select } from '@/components/ui/input'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { cn } from '@/lib/utils'
import type { PeriodView, RoomView, SubjectTeacherAssignment, TimetableEntryView } from './types'
import { DAY_NAMES } from './types'
import { EntryDialog } from './entry-dialog'

export function SectionTimetableTab() {
  const { hasPermission } = useAuth()
  const { years, sections, currentYear } = useAcademicLookups()
  const [yearId, setYearId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [cell, setCell] = useState<{ dayOfWeek: number; periodId: string; entry: TimetableEntryView | null } | null>(null)

  const effectiveYear = yearId || currentYear?.id || years[0]?.id || ''
  const canManage = hasPermission('timetable.manage')

  const periods = useApiQuery<{ periods: PeriodView[] }>(['timetable', 'periods'], '/periods')
  const rooms = useApiQuery<{ rooms: RoomView[] }>(['timetable', 'rooms'], '/academic/rooms')
  const entries = useApiQuery<{ entries: TimetableEntryView[] }>(
    ['timetable', 'entries', sectionId, effectiveYear],
    `/timetable/sections/${sectionId}/years/${effectiveYear}`,
    { enabled: !!sectionId && !!effectiveYear },
  )
  const assignments = useApiQuery<{ assignments: SubjectTeacherAssignment[] }>(
    ['timetable', 'assignments', effectiveYear, sectionId],
    `/academic/years/${effectiveYear}/subject-teachers?sectionId=${sectionId}`,
    { enabled: !!sectionId && !!effectiveYear },
  )

  const sortedPeriods = [...(periods.data?.periods ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
  const entryFor = (day: number, periodId: string) => entries.data?.entries.find((e) => e.dayOfWeek === day && e.periodId === periodId) ?? null
  const assignmentName = (e: TimetableEntryView) => {
    const a = assignments.data?.assignments.find((x) => x.subjectId === e.subjectId && x.staffId === e.staffId)
    return a ? { subject: a.subjectName, staff: a.staffName } : { subject: 'Subject', staff: 'Staff' }
  }

  return (
    <div>
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
        </div>
      </Card>

      <Card className="overflow-x-auto">
        {!sectionId ? (
          <EmptyState title="Select a section to view its timetable" />
        ) : periods.isLoading || entries.isLoading ? (
          <PageLoading />
        ) : sortedPeriods.length === 0 ? (
          <EmptyState title="No periods defined yet" description="Define the bell schedule under Timetable Setup first." />
        ) : (
          <table className="w-full min-w-[800px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="w-32 border-b border-border p-2 text-left text-xs font-medium text-ink-subtle">Period</th>
                {DAY_NAMES.slice(1, 7).map((d) => (
                  <th key={d} className="border-b border-border p-2 text-left text-xs font-medium text-ink-subtle">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedPeriods.map((p) => (
                <tr key={p.id}>
                  <td className="border-b border-border p-2 align-top">
                    <div className="font-medium text-ink">{p.name}</div>
                    <div className="text-xs text-ink-subtle">
                      {p.startTime.slice(0, 5)}–{p.endTime.slice(0, 5)}
                    </div>
                  </td>
                  {[1, 2, 3, 4, 5, 6].map((day) => {
                    const entry = entryFor(day, p.id)
                    const names = entry ? assignmentName(entry) : null
                    return (
                      <td key={day} className="border-b border-border p-1.5 align-top">
                        <button
                          type="button"
                          disabled={!canManage}
                          onClick={() => canManage && setCell({ dayOfWeek: day, periodId: p.id, entry })}
                          className={cn(
                            'w-full rounded-md p-2 text-left transition-colors',
                            entry ? 'bg-brand-50 hover:bg-brand-100' : 'border border-dashed border-border hover:bg-surface-muted',
                            !canManage && 'cursor-default',
                          )}
                        >
                          {entry ? (
                            <>
                              <div className="text-xs font-medium text-ink">{names!.subject}</div>
                              <div className="text-xs text-ink-subtle">{names!.staff}</div>
                            </>
                          ) : canManage ? (
                            <Plus className="size-3.5 text-ink-subtle" />
                          ) : (
                            <span className="text-xs text-ink-subtle">—</span>
                          )}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {cell && (
        <EntryDialog
          sectionId={sectionId}
          academicYearId={effectiveYear}
          dayOfWeek={cell.dayOfWeek}
          periodId={cell.periodId}
          assignments={assignments.data?.assignments ?? []}
          rooms={rooms.data?.rooms ?? []}
          existing={cell.entry}
          onClose={() => setCell(null)}
        />
      )}
    </div>
  )
}
