import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, EmptyState, ErrorState } from '@/components/ui/feedback'
import { StudentSearchBox } from '@/components/student-search-box'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'

type StudentRow = {
  id: string
  admissionNo: string
  firstName: string
  lastName: string | null
  gender: string
  status: string
  admissionDate: string
  phone: string | null
  className: string | null
  sectionName: string | null
  rollNo: number | null
}

export function StudentsListPage() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { classes, sections } = useAcademicLookups()

  const [classId, setClassId] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [status, setStatus] = useState('')

  const list = useCursorList<StudentRow>(
    ['students'],
    '/students',
    { classId: classId || undefined, sectionId: sectionId || undefined, status: status || undefined },
  )

  const filteredSections = sections.filter((s) => !classId || s.classId === classId)

  return (
    <RequirePermission anyOf={['students.read']}>
      <div>
        <PageHeader
          title="Students"
          description="Every enrolled, applied and former student on record."
          actions={
            hasPermission('students.create') && (
              <Button onClick={() => navigate('/students/new')}>
                <Plus className="size-4" />
                Add Student
              </Button>
            )
          }
        />

        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <StudentSearchBox />
            <Select
              className="w-auto min-w-[140px]"
              value={classId}
              onChange={(e) => {
                setClassId(e.target.value)
                setSectionId('')
                list.reset()
              }}
            >
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              className="w-auto min-w-[140px]"
              value={sectionId}
              onChange={(e) => {
                setSectionId(e.target.value)
                list.reset()
              }}
            >
              <option value="">All sections</option>
              {filteredSections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.className} - {s.name}
                </option>
              ))}
            </Select>
            <Select
              className="w-auto min-w-[140px]"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                list.reset()
              }}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="transferred">Transferred</option>
              <option value="graduated">Graduated</option>
            </Select>
          </div>
        </Card>

        <Card>
          {list.isLoading ? (
            <PageLoading />
          ) : list.isError ? (
            <ErrorState description="Could not load students. Try refreshing." />
          ) : !list.data || list.data.items.length === 0 ? (
            <EmptyState title="No students match these filters" />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Admission No</Th>
                    <Th>Name</Th>
                    <Th>Class / Section</Th>
                    <Th>Roll No</Th>
                    <Th>Phone</Th>
                    <Th>Status</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {list.data.items.map((s) => (
                    <Tr key={s.id} className="cursor-pointer" onClick={() => navigate(`/students/${s.id}`)}>
                      <Td className="font-medium text-brand-600">{s.admissionNo}</Td>
                      <Td>
                        {s.firstName} {s.lastName ?? ''}
                      </Td>
                      <Td>{s.className ? `${s.className} - ${s.sectionName}` : '—'}</Td>
                      <Td>{s.rollNo ?? '—'}</Td>
                      <Td>{s.phone ?? '—'}</Td>
                      <Td>
                        <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>

              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <p className="text-xs text-ink-muted">Page {list.page}</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={!list.hasPrev} onClick={list.prevPage}>
                    <ChevronLeft className="size-4" />
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={!list.hasNext} onClick={list.nextPage}>
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </RequirePermission>
  )
}
