import { useState } from 'react'
import { Menu, Search, Bell, LogOut, ChevronDown, User } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { useNavigate } from 'react-router-dom'
import { useApiQuery } from '@/hooks/use-api-query'
import { SchoolLogo } from '@/components/school-logo'

type NotificationItem = { id: string; status: string }

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { me, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()

  const notifications = useApiQuery<{ items: NotificationItem[] }>(['notifications', 'badge'], '/notifications?limit=50')
  const unreadCount = notifications.data?.items.filter((n) => n.status !== 'read').length ?? 0

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button onClick={onMenuClick} className="rounded-md p-2 text-ink-muted hover:bg-surface-muted lg:hidden" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <div className="flex items-center gap-2 lg:hidden">
          <SchoolLogo className="size-8 rounded-full" />
          <span className="text-sm font-semibold text-school-indigo">Junior Cambridge</span>
        </div>
        <div className="relative hidden sm:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <input
            type="search"
            placeholder="Search students, staff, invoices…"
            className="h-9 w-72 rounded-lg border border-border bg-surface-muted pl-9 pr-3 text-sm text-ink placeholder:text-ink-subtle focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate('/notifications')}
          className="relative rounded-full p-2 text-ink-muted hover:bg-surface-muted"
          aria-label="Notifications"
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-danger-500 text-[10px] font-semibold leading-none text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-surface-muted"
          >
            <div className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-brand-600">
              <User className="size-4" />
            </div>
            <span className="hidden text-sm font-medium text-ink sm:inline">{me?.user.username}</span>
            <ChevronDown className="size-4 text-ink-subtle" />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-border bg-surface p-1 shadow-[var(--shadow-card)]">
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-medium text-ink">{me?.user.username}</p>
                  <p className="truncate text-xs text-ink-subtle">{me?.roles.map((r) => r.name).join(', ')}</p>
                </div>
                <div className="my-1 h-px bg-border" />
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger-500 hover:bg-danger-50"
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
