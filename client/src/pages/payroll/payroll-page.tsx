import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { RunsTab } from './runs-tab'
import { SalarySetupTab } from './salary-setup-tab'

export function PayrollPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'runs' | 'setup'>('runs')
  const canSetup = hasPermission('payroll.manage_structures') || hasPermission('payroll.manage_salaries')

  return (
    <RequirePermission anyOf={['payroll.read', 'payroll.read_own']}>
      <div>
        <PageHeader title="Payroll" description="Salary structures, payroll runs, and payslips." />

        {canSetup && (
          <div className="mb-4 flex gap-1 border-b border-border">
            {(['runs', 'setup'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
                  tab === t ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t === 'setup' ? 'Salary Setup' : 'Payroll Runs'}
              </button>
            ))}
          </div>
        )}

        {tab === 'runs' ? <RunsTab /> : <SalarySetupTab />}
      </div>
    </RequirePermission>
  )
}
