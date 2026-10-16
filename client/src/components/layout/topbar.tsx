import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Menu, Bell, CalendarDays, CalendarCheck, LogOut } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { useApiQuery } from '@/hooks/use-api-query'
import { SCHOOL } from '@/lib/school'
import { SchoolLogo } from '@/components/school-logo'
import { StudentSearchBox } from '@/components/student-search-box'

type NotificationItem = { id: string; status: string }

const iconButton = 'relative rounded-md p-2 text-white/80 transition-colors hover:bg-white/10 hover:text-white'

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { me, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()

  const notifications = useApiQuery<{ items: NotificationItem[] }>(['notifications', 'badge'], '/notifications?limit=50')
  const unread = notifications.data?.items.filter((n) => n.status !== 'read').length ?? 0

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="z-20 flex h-14 shrink-0 items-center bg-teal text-white">
      <div className="flex h-full items-center gap-2 px-3 lg:w-[248px] lg:px-4">
        <button onClick={onMenuClick} className={`${iconButton} lg:hidden`} aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <Link to="/" className="flex min-w-0 items-center gap-2.5">
          <SchoolLogo className="size-9 shrink-0 rounded-full bg-white" />
          <span className="hidden truncate text-[14px] font-semibold sm:inline lg:hidden xl:inline">Junior Cambridge</span>
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-between gap-4 px-3 sm:px-5">
        <p className="hidden truncate text-[15px] font-semibold lg:block">{SCHOOL.name} — School Management</p>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="hidden w-80 md:block [&_input]:h-8 [&_input]:rounded-full [&_input]:border-0 [&_input]:bg-white">
            <StudentSearchBox />
          </div>
          <Link to="/timetable" className={iconButton} aria-label="Timetable" title="Timetable">
            <CalendarDays className="size-[18px]" />
          </Link>
          <Link to="/attendance" className={iconButton} aria-label="Attendance" title="Attendance">
            <CalendarCheck className="size-[18px]" />
          </Link>
          <Link to="/notifications" className={iconButton} aria-label="Notifications" title="Notifications">
            <Bell className="size-[18px]" />
            {unread > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-coral ring-2 ring-teal" />}
          </Link>

          <div className="relative ml-1">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center rounded-full ring-2 ring-white/30 transition hover:ring-white/60"
              aria-label="Account"
              title={me?.user.username}
            >
              <SchoolLogo className="size-8 rounded-full bg-white" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-60 rounded-lg border border-border bg-surface p-1.5 text-ink shadow-[var(--shadow-raised)]">
                  <div className="px-3 py-2">
                    <p className="truncate text-sm font-semibold">{me?.user.username}</p>
                    <p className="truncate text-xs text-ink-subtle">{me?.roles.map((r) => r.name).join(', ')}</p>
                  </div>
                  <div className="my-1 h-px bg-border" />
                  <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger-600 hover:bg-coral-soft">
                    <LogOut className="size-4" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
