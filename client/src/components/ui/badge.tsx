import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  success: 'bg-success-50 text-success-600',
  warning: 'bg-warning-50 text-warning-600',
  danger: 'bg-danger-50 text-danger-600',
  info: 'bg-info-50 text-info-600',
  brand: 'bg-brand-50 text-brand-600',
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
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
