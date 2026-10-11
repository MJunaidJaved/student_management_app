import { SCHOOL } from '@/lib/school'
import { cn } from '@/lib/utils'

/** The school crest. The source image has a white background, so place it on white or inside a white badge. */
export function SchoolLogo({ className }: { className?: string }) {
  return <img src={SCHOOL.logo} alt={`${SCHOOL.name} crest`} className={cn('object-contain', className)} draggable={false} />
}
