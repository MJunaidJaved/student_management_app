import { Fragment, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Lock, LockOpen, Plus, Send, Eye, Ban } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, ErrorState, EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { useToast } from '@/components/ui/toast'
import type { ExamScheduleView, ExamView, ReportCardListItem } from './types'
import { ScheduleDialog } from './schedule-dialog'
import { MarksEntryPanel } from './marks-entry-panel'

export function ExamDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { classes } = useAcademicLookups()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [activeMarksSchedule, setActiveMarksSchedule] = useState<string | null>(null)
  const [reportClassId, setReportClassId] = useState('')

  const exam = useApiQuery<ExamView>(['exams', id], `/exams/${id}`)
  const schedules = useApiQuery<{ schedules: ExamScheduleView[] }>(['exams', 'schedules', id], `/exams/${id}/schedules`)
  const reportCards = useApiQuery<{ reportCards: ReportCardListItem[] }>(
    ['exams', 'report-cards', id, reportClassId],
    `/exams/${id}/report-cards?classId=${reportClassId}`,
    { enabled: !!reportClassId },
  )

  const className = (classId: string) => classes.find((c) => c.id === classId)?.name ?? classId

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['exams', id] })

  const publish = useMutation({
    mutationFn: async () => apiClient.post(`/exams/${id}/publish`),
    onSuccess: () => {
      show('success', 'Exam published')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const preview = useMutation({
    mutationFn: async () => apiClient.post(`/exams/${id}/compute-results`),
    onSuccess: (res: { data: { data: { published: number; skipped: string[] } } }) => {
      const r = res.data.data
      show('success', `Preview: ${r.published} would publish, ${r.skipped.length} skipped`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const lock = useMutation({
    mutationFn: async () => apiClient.post(`/exams/${id}/lock`),
    onSuccess: () => {
      show('success', 'Exam locked')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const unlock = useMutation({
    mutationFn: async () => apiClient.post(`/exams/${id}/unlock`),
    onSuccess: () => {
      show('success', 'Exam unlocked')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const cancelSchedule = useMutation({
    mutationFn: async (scheduleId: string) => apiClient.post(`/exam-schedules/${scheduleId}/cancel`),
    onSuccess: () => {
      show('success', 'Schedule cancelled')
      queryClient.invalidateQueries({ queryKey: ['exams', 'schedules', id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (exam.isLoading) return <PageLoading />
  if (exam.isError || !exam.data) return <ErrorState description="Could not load this exam." />

  const e = exam.data
  const classesForReports = [...new Set((schedules.data?.schedules ?? []).map((s) => s.classId))]

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={() => navigate('/exams')} className="mb-2">
        <ArrowLeft className="size-4" />
        Back to Exams
      </Button>

      <PageHeader
        title={e.name}
        description={`${e.startDate} to ${e.endDate}`}
        actions={
          <>
            <Badge tone={statusTone(e.status)} className="mr-2">
              {e.status}
            </Badge>
            {e.status === 'draft' && hasPermission('exams.compute_results') && (
              <Button variant="outline" size="sm" loading={preview.isPending} onClick={() => preview.mutate()}>
                <Eye className="size-4" />
                Preview
              </Button>
            )}
            {e.status === 'draft' && hasPermission('exams.publish') && (
              <Button size="sm" loading={publish.isPending} onClick={() => publish.mutate()}>
                <Send className="size-4" />
                Publish
              </Button>
            )}
            {e.status === 'published' && hasPermission('exams.lock') && (
              <Button variant="outline" size="sm" loading={lock.isPending} onClick={() => lock.mutate()}>
                <Lock className="size-4" />
                Lock
              </Button>
            )}
            {e.status === 'locked' && hasPermission('exams.unlock') && (
              <Button variant="outline" size="sm" loading={unlock.isPending} onClick={() => unlock.mutate()}>
                <LockOpen className="size-4" />
                Unlock
              </Button>
            )}
          </>
        }
      />

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Schedules</CardTitle>
          {e.status === 'draft' && hasPermission('exams.manage') && (
            <Button size="sm" onClick={() => setScheduleOpen(true)}>
              <Plus className="size-4" />
              Add Schedule
            </Button>
          )}
        </CardHeader>
        {schedules.isLoading ? (
          <PageLoading />
        ) : !schedules.data || schedules.data.schedules.length === 0 ? (
          <EmptyState title="No schedules yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Class</Th>
                <Th>Date</Th>
                <Th>Time</Th>
                <Th>Total</Th>
                <Th>Passing</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {schedules.data.schedules.map((s) => (
                <Fragment key={s.id}>
                  <Tr>
                    <Td>{className(s.classId)}</Td>
                    <Td>{s.examDate}</Td>
                    <Td>
                      {s.startTime.slice(0, 5)}–{s.endTime.slice(0, 5)}
                    </Td>
                    <Td>{s.totalMarks}</Td>
                    <Td>{s.passingMarks}</Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        {hasPermission('exams.enter_marks') && (
                          <Button variant="ghost" size="sm" onClick={() => setActiveMarksSchedule(activeMarksSchedule === s.id ? null : s.id)}>
                            {activeMarksSchedule === s.id ? 'Hide Marks' : 'Enter Marks'}
                          </Button>
                        )}
                        {e.status === 'draft' && hasPermission('exams.manage') && (
                          <Button variant="ghost" size="sm" loading={cancelSchedule.isPending} onClick={() => cancelSchedule.mutate(s.id)}>
                            <Ban className="size-4 text-danger-500" />
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                  {activeMarksSchedule === s.id && (
                    <Tr>
                      <Td colSpan={6} className="bg-surface-muted/40 p-0">
                        <MarksEntryPanel schedule={s} academicYearId={e.academicYearId} onClose={() => setActiveMarksSchedule(null)} />
                      </Td>
                    </Tr>
                  )}
                </Fragment>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {hasPermission('exams.read') && classesForReports.length > 0 && (
        <Card className="mt-4">
          <CardHeader className="flex items-center justify-between">
            <CardTitle>Report Cards</CardTitle>
            <Select className="w-52" value={reportClassId} onChange={(ev) => setReportClassId(ev.target.value)}>
              <option value="">Select class…</option>
              {classesForReports.map((cid) => (
                <option key={cid} value={cid}>
                  {className(cid)}
                </option>
              ))}
            </Select>
          </CardHeader>
          {!reportClassId ? (
            <EmptyState title="Select a class to view report cards" />
          ) : reportCards.isLoading ? (
            <PageLoading />
          ) : !reportCards.data || reportCards.data.reportCards.length === 0 ? (
            <EmptyState title="No report cards yet" description="Publish the exam to compute results." />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Roll No</Th>
                  <Th>Name</Th>
                  <Th>Obtained</Th>
                  <Th>Total</Th>
                  <Th>%</Th>
                  <Th>Grade</Th>
                  <Th>Rank</Th>
                </Tr>
              </Thead>
              <Tbody>
                {reportCards.data.reportCards
                  .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
                  .map((r) => (
                    <Tr key={r.id}>
                      <Td>{r.rollNo}</Td>
                      <Td>
                        {r.firstName} {r.lastName ?? ''}
                      </Td>
                      <Td>{r.obtainedMarks}</Td>
                      <Td>{r.totalMarks}</Td>
                      <Td>{r.percentage}%</Td>
                      <Td>{r.grade ?? '—'}</Td>
                      <Td>{r.rank ?? '—'}</Td>
                    </Tr>
                  ))}
              </Tbody>
            </Table>
          )}
        </Card>
      )}

      {scheduleOpen && <ScheduleDialog examId={id} onClose={() => setScheduleOpen(false)} />}
    </div>
  )
}
