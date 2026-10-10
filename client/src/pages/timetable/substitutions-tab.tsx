import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Ban } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { SubstitutionListItem } from './types'
import { AssignSubstitutionDialog } from './assign-substitution-dialog'

export function SubstitutionsTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [assignOpen, setAssignOpen] = useState(false)
  const canManage = hasPermission('substitutions.manage')

  const subs = useApiQuery<{ substitutions: SubstitutionListItem[] }>(['substitutions', date], `/substitutions?date=${date}`)

  const cancel = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/substitutions/${id}/cancel`),
    onSuccess: () => {
      show('success', 'Substitution cancelled')
      queryClient.invalidateQueries({ queryKey: ['substitutions', date] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div>
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {canManage && (
            <div className="ml-auto">
              <Button onClick={() => setAssignOpen(true)}>
                <Plus className="size-4" />
                Assign Substitute
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card>
        {subs.isLoading ? (
          <PageLoading />
        ) : !subs.data || subs.data.substitutions.length === 0 ? (
          <EmptyState title="No substitutions for this date" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Section</Th>
                <Th>Subject</Th>
                <Th>Period</Th>
                <Th>Original Teacher</Th>
                <Th>Substitute</Th>
                <Th>Reason</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {subs.data.substitutions.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.sectionName}</Td>
                  <Td>{s.subjectName}</Td>
                  <Td>{s.periodName}</Td>
                  <Td>{s.originalStaffName}</Td>
                  <Td>{s.substituteName}</Td>
                  <Td className="max-w-[160px] truncate">{s.reason ?? '—'}</Td>
                  <Td>
                    <Badge tone={s.cancelledAt ? 'danger' : 'success'}>{s.cancelledAt ? 'Cancelled' : 'Active'}</Badge>
                  </Td>
                  <Td>
                    {canManage && !s.cancelledAt && (
                      <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate(s.id)}>
                        <Ban className="size-4 text-danger-500" />
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>

      {assignOpen && <AssignSubstitutionDialog onClose={() => setAssignOpen(false)} />}
    </div>
  )
}
