import { Dialog } from '@/components/ui/dialog'
import { PageLoading } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import type { AuditEntryDetail } from './types'

export function AuditDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const entry = useApiQuery<AuditEntryDetail>(['audit', id], `/audit-logs/${id}`)

  return (
    <Dialog open onClose={onClose} title="Audit Entry" size="md">
      {entry.isLoading || !entry.data ? (
        <PageLoading />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-ink-subtle">User</p>
              <p className="text-ink">{entry.data.username ?? 'System'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">Action</p>
              <p className="text-ink capitalize">{entry.data.action}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">Table</p>
              <p className="text-ink">{entry.data.tableName ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">Record ID</p>
              <p className="text-ink">{entry.data.recordId ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">IP Address</p>
              <p className="text-ink">{entry.data.ipAddress ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-ink-subtle">When</p>
              <p className="text-ink">{entry.data.createdAt}</p>
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-ink-subtle">Before</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-muted p-3 text-xs">{JSON.stringify(entry.data.oldValues, null, 2) ?? '—'}</pre>
          </div>
          <div>
            <p className="mb-1 text-xs text-ink-subtle">After</p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-muted p-3 text-xs">{JSON.stringify(entry.data.newValues, null, 2) ?? '—'}</pre>
          </div>
        </div>
      )}
    </Dialog>
  )
}
