import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type LabelHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const field =
  'h-9 w-full rounded-md border border-border-strong bg-surface px-3 text-[13px] text-ink transition-colors ' +
  'focus:outline-none focus:border-teal focus:ring-2 focus:ring-turquoise/30 ' +
  'disabled:opacity-50 disabled:bg-surface-muted'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'placeholder:text-ink-subtle', className)} {...props} />
))
Input.displayName = 'Input'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(field, className)} {...props}>
    {children}
  </select>
))
Select.displayName = 'Select'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-[12.5px] font-medium text-ink-muted', className)} {...props} />
}

export function FieldError({ children }: { children?: string }) {
  if (!children) return null
  return <p className="mt-1 text-xs text-danger-600">{children}</p>
}
