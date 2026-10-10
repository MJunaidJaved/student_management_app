import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import type { ExamStatus, ExamTypeView, ExamView } from './types'
import { CreateExamDialog } from './create-exam-dialog'

export function ExamsListTab() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { years, currentYear } = useAcademicLookups()
  const [yearId, setYearId] = useState('')
  const [status, setStatus] = useState<ExamStatus | ''>('')
  const [createOpen, setCreateOpen] = useState(false)

  const effectiveYear = yearId || currentYear?.id || years[0]?.id || ''
  const types = useApiQuery<{ types: ExamTypeView[] }>(['exams', 'types'], '/exam-types')
  const typeName = (id: string) => types.data?.types.find((t) => t.id === id)?.name ?? id

  const exams = useApiQuery<{ exams: ExamView[] }>(
    ['exams', effectiveYear, status],
    `/exams?${new URLSearchParams({ ...(effectiveYear ? { academicYearId: effectiveYear } : {}), ...(status ? { status } : {}) }).toString()}`,
    { enabled: !!effectiveYear },
  )

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
            <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
            <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as ExamStatus | '')}>
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="locked">Locked</option>
            </Select>
          </div>
          {hasPermission('exams.manage') && (
            <div className="ml-auto">
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Exam
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        {exams.isLoading ? (
          <PageLoading />
        ) : exams.isError ? (
          <ErrorState description="Could not load exams." />
        ) : !exams.data || exams.data.exams.length === 0 ? (
          <EmptyState title="No exams found" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Start</Th>
                <Th>End</Th>
                <Th>Status</Th>
              </Tr>
            </Thead>
            <Tbody>
              {exams.data.exams.map((e) => (
                <Tr key={e.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => navigate(`/exams/${e.id}`)}>
                  <Td className="font-medium text-brand-600">{e.name}</Td>
                  <Td>{typeName(e.examTypeId)}</Td>
                  <Td>{e.startDate}</Td>
                  <Td>{e.endDate}</Td>
                  <Td>
                    <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {createOpen && <CreateExamDialog onClose={() => setCreateOpen(false)} />}
    </div>
  )
}
