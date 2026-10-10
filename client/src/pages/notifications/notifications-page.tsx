import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCheck } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useCursorList } from '@/hooks/use-cursor-list'

type NotificationItem = { id: string; title: string; body: string; status: string; createdAt: string }

export function NotificationsPage() {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const list = useCursorList<NotificationItem>(['notifications'], '/notifications', {})

  const markRead = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const markAllRead = useMutation({
    mutationFn: async () => apiClient.post('/notifications/read-all'),
    onSuccess: () => {
      show('success', 'All notifications marked read')
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const hasUnread = list.data?.items.some((n) => n.status !== 'read')

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="System and workflow notifications addressed to you."
        actions={
          hasUnread && (
            <Button variant="outline" size="sm" loading={markAllRead.isPending} onClick={() => markAllRead.mutate()}>
              <CheckCheck className="size-4" />
              Mark All Read
            </Button>
          )
        }
      />

      <Card>
        {list.isLoading ? (
          <PageLoading />
        ) : list.isError ? (
          <ErrorState description="Could not load notifications." />
        ) : !list.data || list.data.items.length === 0 ? (
          <EmptyState title="No notifications yet" />
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Title</Th>
                  <Th>Message</Th>
                  <Th>Status</Th>
                  <Th>Received</Th>
                  <Th />
                </Tr>
              </Thead>
              <Tbody>
                {list.data.items.map((n) => (
                  <Tr key={n.id}>
                    <Td className="font-medium text-ink">{n.title}</Td>
                    <Td className="max-w-md truncate">{n.body}</Td>
                    <Td>
                      <Badge tone={n.status === 'read' ? 'neutral' : 'brand'}>{n.status}</Badge>
                    </Td>
                    <Td>{n.createdAt}</Td>
                    <Td>
                      {n.status !== 'read' && (
                        <Button variant="ghost" size="sm" loading={markRead.isPending} onClick={() => markRead.mutate(n.id)}>
                          Mark Read
                        </Button>
                      )}
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
    </div>
  )
}
