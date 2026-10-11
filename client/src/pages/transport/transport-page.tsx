import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { RoutesTab } from './routes-tab'
import { FleetTab } from './fleet-tab'
import { AllocationsTab } from './allocations-tab'
import { ComplianceTab } from './compliance-tab'

export function TransportPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'routes' | 'fleet' | 'allocations' | 'compliance'>('routes')
  const canSeeCompliance = hasPermission('transport.read_compliance')

  const tabs = [
    { key: 'routes' as const, label: 'Routes & Stops' },
    { key: 'fleet' as const, label: 'Fleet' },
    { key: 'allocations' as const, label: 'Student Allocations' },
    ...(canSeeCompliance ? [{ key: 'compliance' as const, label: 'Compliance' }] : []),
  ]

  return (
    <RequirePermission anyOf={['transport.read', 'transport.read_own']}>
      <div>
        <PageHeader title="Transport" description="Routes, fleet, student allocations, and compliance." />

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'routes' && <RoutesTab />}
        {tab === 'fleet' && <FleetTab />}
        {tab === 'allocations' && <AllocationsTab />}
        {tab === 'compliance' && canSeeCompliance && <ComplianceTab />}
      </div>
    </RequirePermission>
  )
}
