import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
import { useAuth } from '@/lib/auth-context'
import { ExamsListTab } from './exams-list-tab'
import { GradingSetupTab } from './grading-setup-tab'

const TABS = [
  { key: 'exams', label: 'Exams' },
  { key: 'grading', label: 'Grading Setup' },
] as const

export function ExamsPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'exams' | 'grading'>('exams')
  const canGrading = hasPermission('exams.manage_grading')

  return (
    <RequirePermission anyOf={['exams.read', 'exams.read_own']}>
      <div>
        <PageHeader title="Exams" description="Exam schedules, marks entry, grading, and report cards." />

        {canGrading && <Tabs tabs={TABS} active={tab} onChange={setTab} />}

        {tab === 'exams' ? <ExamsListTab /> : <GradingSetupTab />}
      </div>
    </RequirePermission>
  )
}
