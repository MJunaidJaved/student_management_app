import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, ChevronLeft, ChevronRight, Settings2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, EmptyState, ErrorState } from '@/components/ui/feedback'
import { StaffSearchBox } from '@/components/staff-search-box'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useStaffLookups } from '@/hooks/use-staff-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { StaffRow } from './types'
import { DepartmentsDialog } from './departments-dialog'

export function StaffListPage() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { departments } = useStaffLookups()

  const [departmentId, setDepartmentId] = useState('')
  const [status, setStatus] = useState('')
  const [deptDialogOpen, setDeptDialogOpen] = useState(false)

  const list = useCursorList<StaffRow>(['staff'], '/staff', {
    departmentId: departmentId || undefined,
    status: status || undefined,
  })

  return (
    <RequirePermission anyOf={['staff.read']}>
      <div>
        <PageHeader
          title="Staff"
          description="Every staff member, active and separated."
          actions={
            <>
              {hasPermission('staff.manage_departments') && (
                <Button variant="outline" onClick={() => setDeptDialogOpen(true)}>
                  <Settings2 className="size-4" />
                  Departments
                </Button>
              )}
              {hasPermission('staff.create') && (
                <Button onClick={() => navigate('/staff/new')}>
                  <Plus className="size-4" />
                  Add Staff
                </Button>
              )}
            </>
          }
        />

        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <StaffSearchBox />
            <Select
              className="w-auto min-w-[160px]"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value)
                list.reset()
              }}
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
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
              <option value="resigned">Resigned</option>
              <option value="terminated">Terminated</option>
            </Select>
          </div>
        </Card>

        <Card>
          {list.isLoading ? (
            <PageLoading />
          ) : list.isError ? (
            <ErrorState description="Could not load staff. Try refreshing." />
          ) : !list.data || list.data.items.length === 0 ? (
            <EmptyState title="No staff match these filters" />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Employee No</Th>
                    <Th>Name</Th>
                    <Th>Department</Th>
                    <Th>Designation</Th>
                    <Th>Phone</Th>
                    <Th>Status</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {list.data.items.map((s) => (
                    <Tr key={s.id} className="cursor-pointer" onClick={() => navigate(`/staff/${s.id}`)}>
                      <Td className="font-medium text-brand-600">{s.employeeNo}</Td>
                      <Td>{s.fullName}</Td>
                      <Td>{s.departmentName ?? '—'}</Td>
                      <Td>{s.designationName ?? '—'}</Td>
                      <Td>{s.phone}</Td>
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

        {deptDialogOpen && <DepartmentsDialog onClose={() => setDeptDialogOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
