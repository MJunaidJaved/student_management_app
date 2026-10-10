import { NavLink } from 'react-router-dom'
import { GraduationCap, X } from 'lucide-react'
import { NAV_GROUPS } from '@/lib/nav-config'
import { useAuth } from '@/lib/auth-context'
import { cn } from '@/lib/utils'

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasAnyPermission } = useAuth()

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onClose} aria-hidden />
      )}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-surface transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-xl bg-brand-500 text-white">
              <GraduationCap className="size-5" />
            </div>
            <span className="text-base font-semibold text-ink">SchoolSMS</span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-muted hover:bg-surface-muted lg:hidden">
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
          {NAV_GROUPS.map((group, gi) => {
            const items = group.items.filter((item) => item.permissions.length === 0 || hasAnyPermission(item.permissions))
            if (items.length === 0) return null
            return (
              <div key={gi}>
                {group.label && (
                  <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
                    {group.label}
                  </p>
                )}
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      onClick={onClose}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-brand-50 text-brand-600'
                            : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                        )
                      }
                    >
                      <item.icon className="size-[18px] shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
