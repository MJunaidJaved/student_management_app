import { cn } from '@/lib/utils'

export type TabItem<T extends string> = { key: T; label: string }

/** Segmented pills, the active one filled in teal. */
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
    <div className={cn('mb-5 flex gap-1 overflow-x-auto', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'h-8 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors',
            active === t.key ? 'bg-teal text-white' : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
