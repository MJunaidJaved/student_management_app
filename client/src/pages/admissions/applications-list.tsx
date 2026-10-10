import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { AdmissionApplicationView, ApplicationStatus } from './types'
import { CreateApplicationDialog } from './create-application-dialog'

export function ApplicationsList() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { classes } = useAcademicLookups()
  const [status, setStatus] = useState<ApplicationStatus | ''>('')
  const [appliedClassId, setAppliedClassId] = useState('')
  const [createOpen, setCreateOpen] = useState(false)

  const list = useCursorList<AdmissionApplicationView>(['admissions', status, appliedClassId], '/applications', {
    status: status || undefined,
    appliedClassId: appliedClassId || undefined,
  })

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id

  return (
    <RequirePermission anyOf={['admissions.read']}>
      <div>
        <PageHeader
          title="Admissions"
          description="Enquiries, applications, and conversion to enrolled students."
          actions={
            hasPermission('admissions.create') && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Enquiry
              </Button>
            )
          }
        />

        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
              <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus | '')}>
                <option value="">All</option>
                <option value="enquiry">Enquiry</option>
                <option value="applied">Applied</option>
                <option value="test">Test</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="enrolled">Enrolled</option>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Applied Class</label>
              <Select className="w-44" value={appliedClassId} onChange={(e) => setAppliedClassId(e.target.value)}>
                <option value="">All</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </Card>

        <Card>
          {list.isLoading ? (
            <PageLoading />
          ) : list.isError ? (
            <ErrorState description="Could not load applications." />
          ) : !list.data || list.data.items.length === 0 ? (
            <EmptyState title="No applications found" />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Application No</Th>
                    <Th>Applicant</Th>
                    <Th>Applied Class</Th>
                    <Th>Guardian</Th>
                    <Th>Status</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {list.data.items.map((a) => (
                    <Tr key={a.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => navigate(`/admissions/${a.id}`)}>
                      <Td className="font-medium text-brand-600">{a.applicationNo}</Td>
                      <Td>{a.applicantName}</Td>
                      <Td>{className(a.appliedClassId)}</Td>
                      <Td>
                        {a.guardianName} ({a.guardianPhone})
                      </Td>
                      <Td>
                        <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
              <div className="flex items-center justify-between border-t border-border p-3">
                <Button variant="outline" size="sm" disabled={!list.hasPrev} onClick={list.prevPage}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={!list.hasNext} onClick={list.nextPage}>
                  Next
                </Button>
              </div>
            </>
          )}
        </Card>

        {createOpen && <CreateApplicationDialog onClose={() => setCreateOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
