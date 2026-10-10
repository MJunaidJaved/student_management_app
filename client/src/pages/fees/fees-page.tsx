import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { InvoicesTab } from './invoices-tab'
import { FeeSetupTab } from './fee-setup-tab'

export function FeesPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'invoices' | 'setup'>('invoices')
  const canSetup = hasPermission('fees.manage_structures') || hasPermission('fees.manage_discounts')

  return (
    <RequirePermission anyOf={['fees.read', 'fees.read_own']}>
      <div>
        <PageHeader title="Fees" description="Invoices, payments and fee structure." />

        {canSetup && (
          <div className="mb-4 flex gap-1 border-b border-border">
            {(['invoices', 'setup'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
                  tab === t ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t === 'setup' ? 'Fee Setup' : t}
              </button>
            ))}
          </div>
        )}

        {tab === 'invoices' ? <InvoicesTab /> : <FeeSetupTab />}
      </div>
    </RequirePermission>
  )
}
