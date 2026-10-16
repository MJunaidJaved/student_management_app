import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { HOME_ITEM, NAV_GROUPS } from '@/lib/nav-config'
import { useAuth } from '@/lib/auth-context'
import { useApiQuery } from '@/hooks/use-api-query'
import { cn } from '@/lib/utils'

type CurrentYear = { id: string; name: string }

const isUnder = (pathname: string, path: string) => (path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`))

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasAnyPermission, hasPermission } = useAuth()
  const { pathname } = useLocation()
  const year = useApiQuery<CurrentYear>(['academic', 'years', 'current'], '/academic/years/current', {
    enabled: hasPermission('academic.read'),
    staleTime: 10 * 60_000,
  })

  const groups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((item) => item.permissions.length === 0 || hasAnyPermission(item.permissions)),
  })).filter((g) => g.items.length > 0)

  // The section holding the current page starts open; the rest start closed.
  const activeGroup = groups.find((g) => g.items.some((i) => isUnder(pathname, i.path)))?.label ?? null
  const [expanded, setExpanded] = useState<string | null>(activeGroup)
  useEffect(() => {
    if (activeGroup) setExpanded(activeGroup)
  }, [activeGroup])

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex h-9 items-center gap-2.5 pl-11 pr-3 text-[13px] transition-colors',
      isActive ? 'bg-turquoise-soft font-medium text-teal' : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
    )

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-ink/20 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-border bg-surface transition-transform lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border bg-spring-soft px-4 text-[13px] font-semibold text-ink">
          Current Session: {year.data?.name ?? '—'}
        </div>

        <nav className="flex-1 overflow-y-auto py-2">
          <NavLink
            to={HOME_ITEM.path}
            end
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                'flex h-10 items-center gap-3 px-4 text-[13.5px] font-medium transition-colors',
                isActive ? 'bg-turquoise-soft text-teal' : 'text-ink hover:bg-surface-muted',
              )
            }
          >
            <HOME_ITEM.icon className="size-4 text-ink-muted" />
            {HOME_ITEM.label}
          </NavLink>

          {groups.map((g) => {
            const isOpen = expanded === g.label
            const holdsActive = g.label === activeGroup
            return (
              <div key={g.label} className="border-t border-border/70 first-of-type:border-t-0">
                <button
                  onClick={() => setExpanded(isOpen ? null : g.label)}
                  className={cn(
                    'flex h-10 w-full items-center gap-3 px-4 text-left text-[13.5px] font-medium transition-colors hover:bg-surface-muted',
                    holdsActive ? 'text-teal' : 'text-ink',
                  )}
                  aria-expanded={isOpen}
                >
                  <g.icon className={cn('size-4 shrink-0', holdsActive ? 'text-teal' : 'text-ink-muted')} />
                  <span className="flex-1 truncate">{g.label}</span>
                  {isOpen ? <ChevronDown className="size-4 text-ink-subtle" /> : <ChevronLeft className="size-4 text-ink-subtle" />}
                </button>
                {isOpen && (
                  <div className="pb-1">
                    {g.items.map((item) => (
                      <NavLink key={item.path} to={item.path} end={item.path === '/students'} onClick={onClose} className={linkClass}>
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
