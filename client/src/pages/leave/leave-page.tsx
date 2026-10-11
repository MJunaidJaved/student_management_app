import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { LeaveRequestsTab } from './leave-requests-tab'
import { LeaveSetupTab } from './leave-setup-tab'

const TABS = [
  { key: 'requests', label: 'Requests' },
  { key: 'setup', label: 'Leave Setup' },
] as const

export function LeavePage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'requests' | 'setup'>('requests')
  const canSetup = hasPermission('leave.manage_types') || hasPermission('leave.manage_balances')

  return (
    <RequirePermission anyOf={['leave.read_own']}>
      <div>
        <PageHeader title="Leave Management" description="Leave requests, approvals, and leave policy setup." />

        {canSetup && <Tabs tabs={TABS} active={tab} onChange={setTab} />}

        {tab === 'requests' ? <LeaveRequestsTab /> : <LeaveSetupTab />}
      </div>
    </RequirePermission>
  )
}
