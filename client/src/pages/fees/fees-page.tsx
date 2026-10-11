import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { InvoicesTab } from './invoices-tab'
import { FeeSetupTab } from './fee-setup-tab'

const TABS = [
  { key: 'invoices', label: 'Invoices' },
  { key: 'setup', label: 'Fee Setup' },
] as const

export function FeesPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'invoices' | 'setup'>('invoices')
  const canSetup = hasPermission('fees.manage_structures') || hasPermission('fees.manage_discounts')

  return (
    <RequirePermission anyOf={['fees.read', 'fees.read_own']}>
      <div>
        <PageHeader title="Fees" description="Invoices, payments and fee structure." />

        {canSetup && <Tabs tabs={TABS} active={tab} onChange={setTab} />}

        {tab === 'invoices' ? <InvoicesTab /> : <FeeSetupTab />}
      </div>
    </RequirePermission>
  )
}
