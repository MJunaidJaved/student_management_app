import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { useAuth } from '@/lib/auth-context'
import { SHORTCUTS } from '@/lib/nav-config'

/** The office's starting point: one tile per everyday task, nothing else. */
export function HomePage() {
  const { hasAnyPermission } = useAuth()
  const tiles = SHORTCUTS.filter((s) => s.permissions.length === 0 || hasAnyPermission(s.permissions))

  return (
    <div>
      <PageHeader title="Home" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
        {tiles.map((t) => (
          <Link
            key={t.path}
            to={t.path}
            className="flex h-28 flex-col items-center justify-center gap-2.5 rounded-card border border-border bg-surface px-3 text-center transition-colors hover:border-turquoise hover:bg-turquoise-soft"
          >
            <t.icon className="size-6 text-teal" />
            <span className="text-[13px] font-medium text-ink">{t.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
