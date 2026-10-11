import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { RunsTab } from './runs-tab'
import { SalarySetupTab } from './salary-setup-tab'

const TABS = [
  { key: 'runs', label: 'Payroll Runs' },
  { key: 'setup', label: 'Salary Setup' },
] as const

export function PayrollPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'runs' | 'setup'>('runs')
  const canSetup = hasPermission('payroll.manage_structures') || hasPermission('payroll.manage_salaries')

  return (
    <RequirePermission anyOf={['payroll.read', 'payroll.read_own']}>
      <div>
        <PageHeader title="Payroll" description="Salary structures, payroll runs, and payslips." />

        {canSetup && <Tabs tabs={TABS} active={tab} onChange={setTab} />}

        {tab === 'runs' ? <RunsTab /> : <SalarySetupTab />}
      </div>
    </RequirePermission>
  )
}
