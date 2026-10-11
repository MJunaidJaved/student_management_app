import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { ItemsTab } from './items-tab'
import { PurchaseOrdersTab } from './purchase-orders-tab'
import { LowStockTab } from './low-stock-tab'
import { InventorySetupTab } from './inventory-setup-tab'

export function InventoryPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'items' | 'purchase-orders' | 'low-stock' | 'setup'>('items')
  const canSeeReports = hasPermission('inventory.read_reports')
  const canSetup = hasPermission('inventory.manage_items') || hasPermission('inventory.manage_suppliers')

  const tabs = [
    { key: 'items' as const, label: 'Items & Stock' },
    { key: 'purchase-orders' as const, label: 'Purchase Orders' },
    ...(canSeeReports ? [{ key: 'low-stock' as const, label: 'Low Stock' }] : []),
    ...(canSetup ? [{ key: 'setup' as const, label: 'Setup' }] : []),
  ]

  return (
    <RequirePermission anyOf={['inventory.read']}>
      <div>
        <PageHeader title="Inventory" description="Stock items, purchase orders, and suppliers." />

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {tab === 'items' && <ItemsTab />}
        {tab === 'purchase-orders' && <PurchaseOrdersTab />}
        {tab === 'low-stock' && canSeeReports && <LowStockTab />}
        {tab === 'setup' && canSetup && <InventorySetupTab />}
      </div>
    </RequirePermission>
  )
}
