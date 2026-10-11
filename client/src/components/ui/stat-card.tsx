import type { ComponentType } from 'react'
import { Card } from './card'
import { cn } from '@/lib/utils'

type Accent = 'blue' | 'red' | 'purple' | 'orange' | 'success'

const accentClasses: Record<Accent, string> = {
  blue: 'text-school-indigo',
  purple: 'text-chart-indigo',
  red: 'text-danger-500',
  orange: 'text-warning-500',
  success: 'text-school-green',
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
        <p className="text-sm font-medium text-ink-muted">{label}</p>
        <Icon className={cn('size-5 shrink-0', accentClasses[accent])} />
      </div>
      <p className="mt-3 text-3xl font-semibold leading-none tabular-nums text-ink">{value}</p>
      {sublabel && <p className="mt-2 truncate text-xs text-ink-subtle">{sublabel}</p>}
    </Card>
  )
}
