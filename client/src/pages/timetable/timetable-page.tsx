import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { SectionTimetableTab } from './section-timetable-tab'
import { SubstitutionsTab } from './substitutions-tab'
import { PeriodsSetupTab } from './periods-setup-tab'

export function TimetablePage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'timetable' | 'substitutions' | 'setup'>('timetable')
  const canSetup = hasPermission('timetable.manage_periods')
  const canSeeSubs = hasPermission('substitutions.read')

  const tabs = [
    { key: 'timetable' as const, label: 'Timetable' },
    ...(canSeeSubs ? [{ key: 'substitutions' as const, label: 'Substitutions' }] : []),
    ...(canSetup ? [{ key: 'setup' as const, label: 'Bell Schedule' }] : []),
  ]

  return (
    <RequirePermission anyOf={['timetable.read']}>
      <div>
        <PageHeader title="Timetable" description="Class schedules, bell timings, and substitute teachers." />

        {tabs.length > 1 && (
          <div className="mb-4 flex gap-1 border-b border-border">
            {tabs.map((t) => (
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
        )}

        {tab === 'timetable' && <SectionTimetableTab />}
        {tab === 'substitutions' && canSeeSubs && <SubstitutionsTab />}
        {tab === 'setup' && canSetup && <PeriodsSetupTab />}
      </div>
    </RequirePermission>
  )
}
