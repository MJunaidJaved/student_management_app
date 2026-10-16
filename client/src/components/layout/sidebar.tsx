import { NavLink } from 'react-router-dom'
import { CalendarRange, X } from 'lucide-react'
import { NAV_GROUPS } from '@/lib/nav-config'
import { useAuth } from '@/lib/auth-context'
import { useApiQuery } from '@/hooks/use-api-query'
import { SCHOOL } from '@/lib/school'
import { cn } from '@/lib/utils'
import { SchoolLogo } from '@/components/school-logo'

type CurrentYear = { id: string; name: string; startDate: string; endDate: string }

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasAnyPermission, hasPermission } = useAuth()
  const year = useApiQuery<CurrentYear>(['academic', 'years', 'current'], '/academic/years/current', {
    enabled: hasPermission('academic.read'),
    staleTime: 10 * 60_000,
  })

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-brand-900/40 backdrop-blur-[1px] lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[264px] flex-col border-r border-border bg-surface transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex min-h-16 shrink-0 items-center gap-3 px-5 py-3">
          <SchoolLogo className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold leading-[1.2] text-brand-500">{SCHOOL.name}</p>
            <p className="mt-0.5 truncate text-xs text-ink-subtle">{SCHOOL.location}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-subtle hover:bg-surface-muted lg:hidden" aria-label="Close menu">
            <X className="size-5" />
          </button>
        </div>
        <div className="brand-ribbon mx-5 h-[3px] rounded-full opacity-90" />

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4 pt-5">
          {NAV_GROUPS.map((group, gi) => {
            const items = group.items.filter((item) => item.permissions.length === 0 || hasAnyPermission(item.permissions))
            if (items.length === 0) return null
            return (
              <div key={gi}>
                {group.label && (
                  <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{group.label}</p>
                )}
                <div className="space-y-px">
                  {items.map((item) => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      end={item.path === '/'}
                      onClick={onClose}
                      className={({ isActive }) =>
                        cn(
                          'group flex h-9 items-center gap-3 rounded-lg px-3 text-[14px] transition-colors',
                          isActive
                            ? 'bg-brand-50 font-semibold text-brand-500'
                            : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon
                            className={cn(
                              'size-[18px] shrink-0',
                              isActive ? 'text-brand-500' : 'text-ink-subtle group-hover:text-ink-muted',
                            )}
                          />
                          <span className="truncate">{item.label}</span>
                          {isActive && <span className="ml-auto size-1.5 rounded-full bg-school-sky" />}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            )
          })}
        </nav>

        {year.data && (
          <div className="shrink-0 border-t border-border p-4">
            <div className="flex items-center gap-3 rounded-xl bg-surface-muted px-3 py-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-brand-500 text-white">
                <CalendarRange className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">Academic session</p>
                <p className="truncate text-sm font-semibold text-ink">{year.data.name}</p>
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  )
}
