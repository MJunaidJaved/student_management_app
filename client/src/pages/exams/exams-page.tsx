import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { ExamsListTab } from './exams-list-tab'
import { GradingSetupTab } from './grading-setup-tab'

export function ExamsPage() {
  const { hasPermission } = useAuth()
  const [tab, setTab] = useState<'exams' | 'grading'>('exams')
  const canGrading = hasPermission('exams.manage_grading')

  return (
    <RequirePermission anyOf={['exams.read', 'exams.read_own']}>
      <div>
        <PageHeader title="Exams" description="Exam schedules, marks entry, grading, and report cards." />

        {canGrading && (
          <div className="mb-4 flex gap-1 border-b border-border">
            {(['exams', 'grading'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors',
                  tab === t ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t === 'grading' ? 'Grading Setup' : 'Exams'}
              </button>
            ))}
          </div>
        )}

        {tab === 'exams' ? <ExamsListTab /> : <GradingSetupTab />}
      </div>
    </RequirePermission>
  )
}
