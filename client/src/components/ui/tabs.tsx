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
    <div className={cn('mb-4 flex gap-1 border-b border-border', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
            active === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
