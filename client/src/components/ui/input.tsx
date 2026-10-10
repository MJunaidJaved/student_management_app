import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type LabelHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle',
        'focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-brand-400',
        'disabled:opacity-50 disabled:bg-surface-muted',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink',
        'focus:outline-none focus:ring-2 focus:ring-brand-400 focus:border-brand-400',
        'disabled:opacity-50 disabled:bg-surface-muted',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
)
Select.displayName = 'Select'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-sm font-medium text-ink', className)} {...props} />
}

export function FieldError({ children }: { children?: string }) {
  if (!children) return null
  return <p className="mt-1 text-xs text-danger-500">{children}</p>
}
