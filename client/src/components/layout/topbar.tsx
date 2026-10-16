import { useState } from 'react'
import { Menu, Search, Bell, LogOut, ChevronDown } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { useNavigate } from 'react-router-dom'
import { useApiQuery } from '@/hooks/use-api-query'
import { SchoolLogo } from '@/components/school-logo'

type NotificationItem = { id: string; status: string }

function initials(name: string): string {
  const parts = name.replace(/[._-]+/g, ' ').trim().split(/\s+/)
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2)).toUpperCase()
}

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { me, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()

  const notifications = useApiQuery<{ items: NotificationItem[] }>(['notifications', 'badge'], '/notifications?limit=50')
  const unreadCount = notifications.data?.items.filter((n) => n.status !== 'read').length ?? 0

  const username = me?.user.username ?? ''
  const roleLabel = me?.roles.map((r) => r.name).join(', ') ?? ''

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/95 px-4 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={onMenuClick} className="rounded-lg p-2 text-ink-muted hover:bg-surface-muted lg:hidden" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <div className="flex items-center gap-2 lg:hidden">
          <SchoolLogo className="size-8 rounded-full" />
          <span className="truncate text-sm font-bold text-brand-500">Junior Cambridge</span>
        </div>
        <div className="relative hidden sm:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <input
            type="search"
            placeholder="Search students, staff, invoices…"
            className="h-9 w-80 rounded-lg border border-border bg-surface-muted pl-9 pr-3 text-sm text-ink placeholder:text-ink-subtle transition-colors focus:border-brand-300 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-brand-100"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={() => navigate('/notifications')}
          className="relative rounded-lg p-2 text-ink-muted hover:bg-surface-muted hover:text-ink"
          aria-label="Notifications"
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger-500 px-1 text-[10px] font-semibold leading-4 text-white ring-2 ring-surface">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        <div className="mx-1 hidden h-6 w-px bg-border sm:block" />

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-muted"
          >
            <div className="flex size-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white">
              {initials(username || 'U')}
            </div>
            <div className="hidden text-left leading-tight sm:block">
              <p className="text-sm font-semibold text-ink">{username}</p>
              <p className="max-w-[160px] truncate text-xs text-ink-subtle">{roleLabel}</p>
            </div>
            <ChevronDown className="size-4 text-ink-subtle" />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-2 w-60 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-raised)]">
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-semibold text-ink">{username}</p>
                  <p className="truncate text-xs text-ink-subtle">{roleLabel}</p>
                </div>
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger-500 hover:bg-danger-50"
                >
                  <LogOut className="size-4" />
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
