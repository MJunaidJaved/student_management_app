import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand'

const toneClasses: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  success: 'bg-success-50 text-success-600',
  warning: 'bg-spring-soft text-warning-600',
  danger: 'bg-coral-soft text-danger-600',
  info: 'bg-turquoise-soft text-sky-600',
  brand: 'bg-brand-50 text-teal',
}

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11.5px] font-medium capitalize', toneClasses[tone], className)}
      {...props}
    />
  )
}

/** Maps a handful of common status strings to a sensible tone automatically. */
export function statusTone(status: string): Tone {
  const s = status.toLowerCase()
  if (['active', 'present', 'paid', 'approved', 'posted', 'completed', 'issued', 'current', 'received', 'accepted', 'enrolled'].includes(s)) return 'success'
  if (['pending', 'draft', 'partial', 'ordered', 'late', 'applied', 'test', 'enquiry'].includes(s)) return 'warning'
  if (['inactive', 'absent', 'rejected', 'cancelled', 'overdue', 'unpaid', 'lost', 'resigned', 'terminated', 'withdrawn'].includes(s)) return 'danger'
  if (['published', 'locked', 'leave'].includes(s)) return 'info'
  return 'neutral'
}
