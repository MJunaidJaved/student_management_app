import { PageHeader } from '@/components/ui/page-header'
import { RequirePermission } from '@/components/protected-route'
import { SubstitutionsTab } from './substitutions-tab'

export function SubstitutionsPage() {
  return (
    <RequirePermission anyOf={['substitutions.read']}>
      <div>
        <PageHeader title="Substitutions" description="Assign and track substitute teachers for scheduled classes." />
        <SubstitutionsTab />
      </div>
    </RequirePermission>
  )
}
