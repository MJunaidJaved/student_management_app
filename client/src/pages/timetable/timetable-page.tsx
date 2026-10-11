import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
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

        {tabs.length > 1 && <Tabs tabs={tabs} active={tab} onChange={setTab} />}

        {tab === 'timetable' && <SectionTimetableTab />}
        {tab === 'substitutions' && canSeeSubs && <SubstitutionsTab />}
        {tab === 'setup' && canSetup && <PeriodsSetupTab />}
      </div>
    </RequirePermission>
  )
}
