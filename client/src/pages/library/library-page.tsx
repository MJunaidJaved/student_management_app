import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { CatalogTab } from './catalog-tab'
import { CirculationTab } from './circulation-tab'
import { ReportsTab } from './reports-tab'
import { LibrarySetupTab } from './library-setup-tab'

export function LibraryPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'catalog' | 'circulation' | 'reports' | 'setup'>('catalog')
  const canCirculate = hasPermission('library.issue') || hasPermission('library.return') || hasPermission('library.renew')
  const canSeeReports = hasPermission('library.read_reports')
  const canSetup = hasPermission('library.manage_catalog')

  const tabs = [
    { key: 'catalog' as const, label: 'Catalog' },
    ...(canCirculate ? [{ key: 'circulation' as const, label: 'Circulation' }] : []),
    ...(canSeeReports ? [{ key: 'reports' as const, label: 'Reports' }] : []),
    ...(canSetup ? [{ key: 'setup' as const, label: 'Setup' }] : []),
  ]

  return (
    <RequirePermission anyOf={['library.read', 'library.read_own']}>
      <div>
        <PageHeader title="Library" description="Catalog, circulation, fines, and reports." />

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'catalog' && <CatalogTab />}
        {tab === 'circulation' && canCirculate && <CirculationTab />}
        {tab === 'reports' && canSeeReports && <ReportsTab />}
        {tab === 'setup' && canSetup && <LibrarySetupTab />}
      </div>
    </RequirePermission>
  )
}
