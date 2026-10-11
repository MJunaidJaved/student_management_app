import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge, statusTone } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { StudentPicker } from '@/components/student-picker'
import { StaffPicker } from '@/components/staff-picker'
import type { BookIssueListItem, BorrowerType, LibraryFineView } from './types'

type FineListItem = LibraryFineView & { title: string; accessionNo: string }

export function CirculationTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [borrowerType, setBorrowerType] = useState<BorrowerType>('student')
  const [borrower, setBorrower] = useState<{ id: string; label: string } | null>(null)
  const [lostIssueId, setLostIssueId] = useState<string | null>(null)
  const [waiveFineId, setWaiveFineId] = useState<string | null>(null)

  const issues = useApiQuery<{ issues: BookIssueListItem[] }>(
    ['library', 'issues', borrowerType, borrower?.id],
    `/borrowers/${borrowerType}/${borrower?.id}/book-issues`,
    { enabled: !!borrower },
  )
  const fines = useApiQuery<{ fines: FineListItem[] }>(
    ['library', 'fines', borrowerType, borrower?.id],
    `/borrowers/${borrowerType}/${borrower?.id}/library-fines`,
    { enabled: !!borrower },
  )

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['library', 'issues', borrowerType, borrower?.id] })
    queryClient.invalidateQueries({ queryKey: ['library', 'fines', borrowerType, borrower?.id] })
  }

  const returnBook = useMutation({
    mutationFn: async (issueId: string) => apiClient.post(`/book-issues/${issueId}/return`),
    onSuccess: () => {
      show('success', 'Book returned')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const renew = useMutation({
    mutationFn: async (issueId: string) => apiClient.post(`/book-issues/${issueId}/renew`),
    onSuccess: () => {
      show('success', 'Book renewed')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const lostForm = useForm<{ replacementCost: string }>()
  const markLost = useMutation({
    mutationFn: async (v: { replacementCost: string }) => apiClient.post(`/book-issues/${lostIssueId}/mark-lost`, v),
    onSuccess: () => {
      show('success', 'Book marked lost')
      invalidate()
      setLostIssueId(null)
      lostForm.reset()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const waiveForm = useForm<{ reason: string }>()
  const waive = useMutation({
    mutationFn: async (v: { reason: string }) => apiClient.post(`/library-fines/${waiveFineId}/waive`, v),
    onSuccess: () => {
      show('success', 'Fine waived')
      invalidate()
      setWaiveFineId(null)
      waiveForm.reset()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="mb-3 flex gap-1">
          <Button type="button" size="sm" variant={borrowerType === 'student' ? 'primary' : 'outline'} onClick={() => { setBorrowerType('student'); setBorrower(null) }}>
            Student
          </Button>
          <Button type="button" size="sm" variant={borrowerType === 'staff' ? 'primary' : 'outline'} onClick={() => { setBorrowerType('staff'); setBorrower(null) }}>
            Staff
          </Button>
        </div>

        {borrowerType === 'student' ? (
          <StudentPicker onSelect={(s) => setBorrower({ id: s.id, label: `${s.firstName} ${s.lastName ?? ''} (${s.admissionNo})` })} />
        ) : (
          <StaffPicker onSelect={(s) => setBorrower({ id: s.id, label: `${s.fullName} (${s.employeeNo})` })} />
        )}
        {borrower && <p className="mt-1 text-xs text-ink-muted">{borrower.label}</p>}
      </Card>

      {borrower && (
        <Card>
          {issues.isLoading ? (
            <PageLoading />
          ) : !issues.data || issues.data.issues.length === 0 ? (
            <EmptyState title="No book issues for this borrower" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Book</Th>
                  <Th>Issued</Th>
                  <Th>Due</Th>
                  <Th>Returned</Th>
                  <Th>Status</Th>
                  <Th>Renewals</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {issues.data.issues.map((it) => (
                  <Tr key={it.id}>
                    <Td className="font-medium text-ink">
                      {it.title} <span className="text-xs text-ink-subtle">({it.accessionNo})</span>
                    </Td>
                    <Td>{it.issueDate}</Td>
                    <Td>{it.dueDate}</Td>
                    <Td>{it.returnDate ?? '—'}</Td>
                    <Td>
                      <Badge tone={statusTone(it.status)}>{it.status}</Badge>
                    </Td>
                    <Td>{it.renewalCount}</Td>
                    <Td>
                      {it.status === 'issued' && (
                        <div className="flex justify-end gap-1">
                          {hasPermission('library.return') && (
                            <Button variant="ghost" size="sm" loading={returnBook.isPending} onClick={() => returnBook.mutate(it.id)}>
                              Return
                            </Button>
                          )}
                          {hasPermission('library.renew') && (
                            <Button variant="ghost" size="sm" loading={renew.isPending} onClick={() => renew.mutate(it.id)}>
                              Renew
                            </Button>
                          )}
                          {hasPermission('library.mark_lost') && (
                            <Button variant="ghost" size="sm" onClick={() => setLostIssueId(it.id)}>
                              Mark Lost
                            </Button>
                          )}
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>
      )}

      {borrower && (
        <Card className="mt-4">
          <div className="p-4">
            <h4 className="text-sm font-semibold text-ink">Fines</h4>
          </div>
          {fines.isLoading ? (
            <PageLoading />
          ) : !fines.data || fines.data.fines.length === 0 ? (
            <EmptyState title="No fines for this borrower" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Book</Th>
                  <Th>Amount</Th>
                  <Th>Status</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {fines.data.fines.map((f) => (
                  <Tr key={f.id}>
                    <Td>
                      {f.title} <span className="text-xs text-ink-subtle">({f.accessionNo})</span>
                    </Td>
                    <Td>{f.amount}</Td>
                    <Td>
                      <Badge tone={statusTone(f.status)}>{f.status}</Badge>
                    </Td>
                    <Td>
                      {f.status === 'unpaid' && hasPermission('library.manage_fines') && (
                        <Button variant="ghost" size="sm" onClick={() => setWaiveFineId(f.id)}>
                          Waive
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>
      )}

      {lostIssueId && (
        <Card className="mt-4 p-4">
          <h4 className="mb-3 text-sm font-semibold text-ink">Mark Lost</h4>
          <form onSubmit={lostForm.handleSubmit((v) => markLost.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Replacement Cost</Label>
              <Input type="number" step="0.01" {...lostForm.register('replacementCost', { required: true })} />
            </div>
            <Button type="submit" loading={markLost.isPending}>
              Confirm
            </Button>
            <Button type="button" variant="outline" onClick={() => setLostIssueId(null)}>
              Cancel
            </Button>
          </form>
        </Card>
      )}

      {waiveFineId && (
        <Card className="mt-4 p-4">
          <h4 className="mb-3 text-sm font-semibold text-ink">Waive Fine</h4>
          <form onSubmit={waiveForm.handleSubmit((v) => waive.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <Label>Reason</Label>
              <Input {...waiveForm.register('reason', { required: true })} />
            </div>
            <Button type="submit" loading={waive.isPending}>
              Confirm
            </Button>
            <Button type="button" variant="outline" onClick={() => setWaiveFineId(null)}>
              Cancel
            </Button>
          </form>
        </Card>
      )}
    </div>
  )
}
