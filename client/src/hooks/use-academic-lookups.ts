import { useApiQuery } from './use-api-query'
import { useAuth } from '@/lib/auth-context'

export type ClassOption = { id: string; name: string; levelOrder: number }
export type SectionOption = {
  id: string
  classId: string
  name: string
  capacity: number
  strength: number
  className: string
}
export type AcademicYearOption = { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean; isClosed: boolean }

/** Classes, sections and years — small reference lists, cached and reused across every filter/form that needs them. */
export function useAcademicLookups() {
  const { hasPermission } = useAuth()
  const enabled = hasPermission('academic.read')

  const classes = useApiQuery<{ classes: ClassOption[] }>(['academic', 'classes'], '/academic/classes', { enabled })
  const sections = useApiQuery<{ sections: SectionOption[] }>(['academic', 'sections'], '/academic/sections', { enabled })
  const years = useApiQuery<{ years: AcademicYearOption[] }>(['academic', 'years'], '/academic/years', { enabled })

  return {
    classes: classes.data?.classes ?? [],
    sections: sections.data?.sections ?? [],
    years: years.data?.years ?? [],
    currentYear: years.data?.years.find((y) => y.isCurrent) ?? null,
    isLoading: classes.isLoading || sections.isLoading || years.isLoading,
  }
}
