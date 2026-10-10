import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { LeaveRequestsTab } from './leave-requests-tab'
import { LeaveSetupTab } from './leave-setup-tab'

export function LeavePage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'requests' | 'setup'>('requests')
  const canSetup = hasPermission('leave.manage_types') || hasPermission('leave.manage_balances')

  return (
    <RequirePermission anyOf={['leave.read_own']}>
      <div>
        <PageHeader title="Leave Management" description="Leave requests, approvals, and leave policy setup." />

        {canSetup && (
          <div className="mb-4 flex gap-1 border-b border-border">
            {(['requests', 'setup'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
                  tab === t ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t === 'setup' ? 'Leave Setup' : 'Requests'}
              </button>
            ))}
          </div>
        )}

        {tab === 'requests' ? <LeaveRequestsTab /> : <LeaveSetupTab />}
      </div>
    </RequirePermission>
  )
}
