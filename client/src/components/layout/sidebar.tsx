import { NavLink } from 'react-router-dom'
import { X } from 'lucide-react'
import { NAV_GROUPS } from '@/lib/nav-config'
import { useAuth } from '@/lib/auth-context'
import { SCHOOL } from '@/lib/school'
import { cn } from '@/lib/utils'
import { SchoolLogo } from '@/components/school-logo'

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasAnyPermission } = useAuth()

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-school-indigo transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-4">
          <div className="size-11 shrink-0 overflow-hidden rounded-full bg-white">
            <SchoolLogo className="size-full" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug text-white">{SCHOOL.name}</p>
            <p className="text-xs text-brand-300">{SCHOOL.location}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-brand-200 hover:bg-white/10 lg:hidden" aria-label="Close menu">
            <X className="size-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4 [scrollbar-color:rgba(255,255,255,0.15)_transparent]">
          {NAV_GROUPS.map((group, gi) => {
            const items = group.items.filter((item) => item.permissions.length === 0 || hasAnyPermission(item.permissions))
            if (items.length === 0) return null
            return (
              <div key={gi}>
                {group.label && (
                  <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-brand-300">{group.label}</p>
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
                          'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                          isActive
                            ? 'bg-white/10 font-semibold text-white before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-laurel'
                            : 'text-brand-200 hover:bg-white/5 hover:text-white',
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
