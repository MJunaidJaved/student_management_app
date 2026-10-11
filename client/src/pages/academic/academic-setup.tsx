import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { Tabs } from '@/components/ui/tabs'
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

        <Tabs tabs={TABS} active={tab} onChange={setTab} />

        {tab === 'years' && <YearsTab />}
        {tab === 'classes' && <ClassesTab />}
        {tab === 'sections' && <SectionsTab />}
        {tab === 'subjects' && <SubjectsTab />}
        {tab === 'rooms' && <RoomsTab />}
      </div>
    </RequirePermission>
  )
}
