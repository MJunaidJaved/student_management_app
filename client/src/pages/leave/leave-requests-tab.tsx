import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Check, X as XIcon, Ban } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useCursorList } from '@/hooks/use-cursor-list'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { LeaveRequestView, LeaveTypeView, LeaveStatus } from './types'
import { NewLeaveRequestDialog } from './new-leave-request-dialog'

export function LeaveRequestsTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<LeaveStatus | ''>('')
  const [applicantType, setApplicantType] = useState<'student' | 'staff' | ''>('')
  const [newOpen, setNewOpen] = useState(false)

  const leaveTypes = useApiQuery<{ leaveTypes: LeaveTypeView[] }>(['leave', 'types'], '/leave-types')
  const leaveTypeName = (id: string) => leaveTypes.data?.leaveTypes.find((t) => t.id === id)?.name ?? id

  const list = useCursorList<LeaveRequestView>(['leave', 'requests'], '/leave/requests', {
    status: status || undefined,
    applicantType: applicantType || undefined,
  })

  const canApproveStudent = hasPermission('leave.approve_student')
  const canApproveStaff = hasPermission('leave.approve_staff')

  const decide = useMutation({
    mutationFn: async ({ req, decision }: { req: LeaveRequestView; decision: 'approved' | 'rejected' }) => {
      const path = req.applicantType === 'student' ? `/leave/student-requests/${req.id}/decide` : `/leave/staff-requests/${req.id}/decide`
      await apiClient.post(path, { decision })
    },
    onSuccess: () => {
      show('success', 'Request updated')
      queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const cancel = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/leave/requests/${id}/cancel`),
    onSuccess: () => {
      show('success', 'Request cancelled')
      queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  function canDecide(req: LeaveRequestView) {
    if (req.status !== 'pending') return false
    if (req.applicantType === 'student') return canApproveStudent
    return canApproveStaff
  }

  function canCancel(req: LeaveRequestView) {
    // Ownership of one's own request is enforced server-side (the backend
    // doesn't expose the actor's staffId/enrollmentId to the frontend), so
    // this just offers the control to anyone plausibly entitled and lets
    // a 403 surface via the mutation's error toast otherwise.
    return req.status === 'pending'
  }

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Status</label>
            <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value as LeaveStatus | '')}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Applicant</label>
            <Select className="w-40" value={applicantType} onChange={(e) => setApplicantType(e.target.value as 'student' | 'staff' | '')}>
              <option value="">All</option>
              <option value="student">Student</option>
              <option value="staff">Staff</option>
            </Select>
          </div>
          <div className="ml-auto">
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="size-4" />
              Request Leave
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        {list.isLoading ? (
          <PageLoading />
        ) : list.isError ? (
          <ErrorState description="Could not load leave requests." />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState title="No leave requests found" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Applicant</Th>
                  <Th>Leave Type</Th>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th>Reason</Th>
                  <Th>Status</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {list.data.items.map((req) => (
                  <Tr key={req.id}>
                    <Td className="capitalize">{req.applicantType}</Td>
                    <Td>{leaveTypeName(req.leaveTypeId)}</Td>
                    <Td>{req.fromDate}</Td>
                    <Td>{req.toDate}</Td>
                    <Td className="max-w-[200px] truncate">{req.reason ?? '—'}</Td>
                    <Td>
                      <Badge tone={statusTone(req.status)}>{req.status}</Badge>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-1">
                        {canDecide(req) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={decide.isPending}
                              onClick={() => decide.mutate({ req, decision: 'approved' })}
                            >
                              <Check className="size-4 text-success-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={decide.isPending}
                              onClick={() => decide.mutate({ req, decision: 'rejected' })}
                            >
                              <XIcon className="size-4 text-danger-500" />
                            </Button>
                          </>
                        )}
                        {canCancel(req) && (
                          <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(req.id)}>
                            <Ban className="size-4 text-ink-subtle" />
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-border p-3">
              <Button variant="outline" size="sm" disabled={!list.hasPrev} onClick={list.prevPage}>
                Previous
              </Button>
              <span className="text-xs text-ink-subtle">Page {list.page}</span>
              <Button variant="outline" size="sm" disabled={!list.hasNext} onClick={list.nextPage}>
                Next
              </Button>
            </div>
          </>
        )}
      </Card>

      {newOpen && <NewLeaveRequestDialog onClose={() => setNewOpen(false)} />}
    </div>
  )
}
