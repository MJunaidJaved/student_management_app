import { useApiQuery } from './use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { Department, Designation } from '@/pages/staff/types'

export function useStaffLookups() {
  const { hasPermission } = useAuth()
  const enabled = hasPermission('staff.manage_departments')

  const departments = useApiQuery<{ departments: Department[] }>(['staff', 'departments'], '/departments', { enabled })
  const designations = useApiQuery<{ designations: Designation[] }>(['staff', 'designations'], '/designations', { enabled })

  return {
    departments: departments.data?.departments ?? [],
    designations: designations.data?.designations ?? [],
  }
}
