import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { VouchersTab } from './vouchers-tab'
import { AccountingSetupTab } from './setup-tab'
import { AccountingReportsTab } from './accounting-reports-tab'

export function AccountingPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'vouchers' | 'reports' | 'setup'>('vouchers')
  const canSetup = hasPermission('accounting.manage_heads')

  return (
    <RequirePermission anyOf={['accounting.read']}>
      <div>
        <PageHeader title="Accounting" description="Vouchers, ledgers, and the trial balance." />

        <div className="mb-4 flex gap-1 border-b border-border">
          {(
            [
              { key: 'vouchers' as const, label: 'Vouchers' },
              { key: 'reports' as const, label: 'Reports' },
              ...(canSetup ? [{ key: 'setup' as const, label: 'Setup' }] : []),
            ]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                tab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'vouchers' && <VouchersTab />}
        {tab === 'reports' && <AccountingReportsTab />}
        {tab === 'setup' && canSetup && <AccountingSetupTab />}
      </div>
    </RequirePermission>
  )
}
