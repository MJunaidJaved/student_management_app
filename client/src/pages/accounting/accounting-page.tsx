import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { VouchersTab } from './vouchers-tab'
import { AccountingSetupTab } from './setup-tab'
import { AccountingReportsTab } from './accounting-reports-tab'

export function AccountingPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'vouchers' | 'reports' | 'setup'>('vouchers')
  const canSetup = hasPermission('accounting.manage_heads')

  const tabs = [
    { key: 'vouchers' as const, label: 'Vouchers' },
    { key: 'reports' as const, label: 'Reports' },
    ...(canSetup ? [{ key: 'setup' as const, label: 'Setup' }] : []),
  ]

  return (
    <RequirePermission anyOf={['accounting.read']}>
      <div>
        <PageHeader title="Accounting" description="Vouchers, ledgers, and the trial balance." />

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'vouchers' && <VouchersTab />}
        {tab === 'reports' && <AccountingReportsTab />}
        {tab === 'setup' && canSetup && <AccountingSetupTab />}
      </div>
    </RequirePermission>
  )
}
