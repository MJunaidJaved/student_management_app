import type { ComponentType } from 'react'
import { Card } from './card'
import { cn } from '@/lib/utils'

type Accent = 'blue' | 'red' | 'purple' | 'orange' | 'success'

const accentClasses: Record<Accent, string> = {
  blue: 'bg-accent-blue/10 text-accent-blue',
  red: 'bg-accent-red/10 text-accent-red',
  purple: 'bg-accent-purple/10 text-accent-purple',
  orange: 'bg-accent-orange/10 text-accent-orange',
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
      <div className="flex items-center gap-4">
        <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', accentClasses[accent])}>
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-ink-muted">{label}</p>
          <p className="text-xl font-semibold text-ink">{value}</p>
          {sublabel && <p className="truncate text-xs text-ink-subtle">{sublabel}</p>}
        </div>
      </div>
    </Card>
  )
}
