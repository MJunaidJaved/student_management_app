import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { cn } from '@/lib/utils'
import { YearsTab } from './years-tab'
import { ClassesTab } from './classes-tab'
import { SectionsTab } from './sections-tab'
import { SubjectsTab } from './subjects-tab'
import { RoomsTab } from './rooms-tab'

const TABS = [
  { key: 'years', label: 'Academic Years' },
  { key: 'classes', label: 'Classes' },
  { key: 'sections', label: 'Sections' },
  { key: 'subjects', label: 'Subjects' },
  { key: 'rooms', label: 'Rooms' },
] as const
type TabKey = (typeof TABS)[number]['key']

export function AcademicSetupPage() {
  const [tab, setTab] = useState<TabKey>('years')

  return (
    <RequirePermission anyOf={['academic.read']}>
      <div>
        <PageHeader title="Academic Setup" description="Years, terms, classes, sections, subjects and rooms." />

        <div className="mb-4 flex gap-1 border-b border-border">
          {TABS.map((t) => (
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

        {tab === 'years' && <YearsTab />}
        {tab === 'classes' && <ClassesTab />}
        {tab === 'sections' && <SectionsTab />}
        {tab === 'subjects' && <SubjectsTab />}
        {tab === 'rooms' && <RoomsTab />}
      </div>
    </RequirePermission>
  )
}
