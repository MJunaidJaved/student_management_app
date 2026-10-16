import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

type Accent = 'blue' | 'red' | 'purple' | 'orange' | 'success' | 'sky'

const iconTone: Record<Accent, string> = {
  blue: 'text-teal',
  purple: 'text-sky-600',
  sky: 'text-sky-600',
  red: 'text-coral',
  orange: 'text-warning-600',
  success: 'text-success-500',
}

/** A quiet number tile: muted block, large figure, small label. */
export function StatCard({
  label,
  value,
  icon: Icon,
  accent = 'blue',
  sublabel,
  className,
}: {
  label: string
  value: string | number
  icon?: ComponentType<{ className?: string }>
  accent?: Accent
  sublabel?: string
  className?: string
}) {
  return (
    <div className={cn('rounded-card bg-surface-muted p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[26px] font-medium leading-none tracking-tight tabular-nums text-ink">{value}</p>
        {Icon && <Icon className={cn('size-4 shrink-0', iconTone[accent])} />}
      </div>
      <p className="mt-3 text-[13px] text-ink-muted">{label}</p>
      {sublabel && <p className="mt-0.5 truncate text-xs text-ink-subtle">{sublabel}</p>}
    </div>
  )
}
