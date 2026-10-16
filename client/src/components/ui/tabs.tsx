import { cn } from '@/lib/utils'

export type TabItem<T extends string> = { key: T; label: string }

/** The underlined tab bar used at the top of every tabbed module page. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: readonly TabItem<T>[]
  active: T
  onChange: (key: T) => void
  className?: string
}) {
  return (
    <div className={cn('mb-5 flex gap-1 overflow-x-auto border-b border-border', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-semibold transition-colors',
            active === t.key ? 'border-brand-500 text-brand-500' : 'border-transparent text-ink-subtle hover:border-border-strong hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
