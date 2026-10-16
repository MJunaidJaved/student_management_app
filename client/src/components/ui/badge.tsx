import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted ring-border-strong/70',
  success: 'bg-success-50 text-success-600 ring-success-500/20',
  warning: 'bg-warning-50 text-warning-600 ring-warning-500/25',
  danger: 'bg-danger-50 text-danger-600 ring-danger-500/20',
  info: 'bg-info-50 text-info-600 ring-info-500/25',
  brand: 'bg-brand-50 text-brand-500 ring-brand-500/15',
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  )
}

/** Maps a handful of common status strings to a sensible tone automatically. */
export function statusTone(status: string): Tone {
  const s = status.toLowerCase()
  if (['active', 'present', 'paid', 'approved', 'posted', 'completed', 'issued', 'current'].includes(s)) return 'success'
  if (['pending', 'draft', 'partial', 'ordered', 'late'].includes(s)) return 'warning'
  if (['inactive', 'absent', 'rejected', 'cancelled', 'overdue', 'unpaid', 'lost', 'resigned', 'terminated', 'withdrawn'].includes(s)) return 'danger'
  return 'neutral'
}
