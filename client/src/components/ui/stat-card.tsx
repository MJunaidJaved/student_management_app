import type { ComponentType } from 'react'
import { Card } from './card'
import { cn } from '@/lib/utils'

type Accent = 'blue' | 'red' | 'purple' | 'orange' | 'success' | 'sky'

/** Icon chips in the crest's colours: indigo, sky, laurel, plus the status hues. */
const chipClasses: Record<Accent, string> = {
  blue: 'bg-brand-50 text-brand-500',
  purple: 'bg-sky-50 text-sky-600',
  sky: 'bg-sky-50 text-sky-600',
  red: 'bg-danger-50 text-danger-500',
  orange: 'bg-warning-50 text-warning-600',
  success: 'bg-success-50 text-success-600',
}

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  sublabel,
}: {
  label: string
  value: string | number
  icon: ComponentType<{ className?: string }>
  accent?: Accent
  sublabel?: string
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink-muted">{label}</p>
          <p className="mt-2 text-[28px] font-bold leading-none tracking-tight tabular-nums text-ink">{value}</p>
        </div>
        <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', chipClasses[accent])}>
          <Icon className="size-5" />
        </div>
      </div>
      {sublabel && <p className="mt-3 truncate text-xs text-ink-subtle">{sublabel}</p>}
    </Card>
  )
}
