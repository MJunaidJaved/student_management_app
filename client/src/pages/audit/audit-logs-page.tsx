import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient } from '@/lib/api-client'
import { RequirePermission } from '@/components/protected-route'
import type { Envelope } from '@/types/api'
import type { AuditEntry } from './types'
import { AuditDetailDialog } from './audit-detail-dialog'

export function AuditLogsPage() {
  const [tableName, setTableName] = useState('')
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const cursor = cursorStack[cursorStack.length - 1]

  const query = useQuery({
    queryKey: ['audit', tableName, action, from, to, cursor],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (tableName) params.set('tableName', tableName)
      if (action) params.set('action', action)
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (cursor) params.set('cursor', cursor)
      const res = await apiClient.get<Envelope<{ entries: AuditEntry[] }>>(`/audit-logs?${params.toString()}`)
      return { entries: res.data.data.entries, page: res.data.meta.page }
    },
    placeholderData: keepPreviousData,
  })

  function resetAndSet(setter: (v: string) => void) {
    return (v: string) => {
      setter(v)
      setCursorStack([])
    }
  }

  return (
    <RequirePermission anyOf={['audit.read']}>
      <div>
        <PageHeader title="Audit Logs" description="Who changed what, and when." />

        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Table</label>
              <Input className="w-40" value={tableName} onChange={(e) => resetAndSet(setTableName)(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">Action</label>
              <Input className="w-32" value={action} onChange={(e) => resetAndSet(setAction)(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">From</label>
              <Input type="date" value={from} onChange={(e) => resetAndSet(setFrom)(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-ink">To</label>
              <Input type="date" value={to} onChange={(e) => resetAndSet(setTo)(e.target.value)} />
            </div>
          </div>
        </Card>

        <Card>
          {query.isLoading ? (
            <PageLoading />
          ) : query.isError ? (
            <ErrorState description="Could not load audit logs." />
          ) : !query.data || query.data.entries.length === 0 ? (
            <EmptyState title="No audit entries found" />
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>When</Th>
                    <Th>User</Th>
                    <Th>Action</Th>
                    <Th>Table</Th>
                    <Th>Record</Th>
                    <Th>IP</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {query.data.entries.map((e) => (
                    <Tr key={e.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => setActiveId(e.id)}>
                      <Td>{e.createdAt}</Td>
                      <Td>{e.username ?? 'System'}</Td>
                      <Td className="capitalize">{e.action}</Td>
                      <Td>{e.tableName ?? '—'}</Td>
                      <Td>{e.recordId ?? '—'}</Td>
                      <Td>{e.ipAddress ?? '—'}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
              <div className="flex items-center justify-between border-t border-border p-3">
                <Button variant="outline" size="sm" disabled={cursorStack.length === 0} onClick={() => setCursorStack((s) => s.slice(0, -1))}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!query.data.page?.hasMore}
                  onClick={() => query.data!.page?.nextCursor && setCursorStack((s) => [...s, query.data!.page!.nextCursor!])}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Card>

        {activeId && <AuditDetailDialog id={activeId} onClose={() => setActiveId(null)} />}
      </div>
    </RequirePermission>
  )
}
