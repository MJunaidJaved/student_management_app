import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { SCHOOL } from '@/lib/school'
import { Sidebar } from './sidebar'
import { Topbar } from './topbar'

/** Full-width header, sections down the left, the page on a light grey ground, a footer under it. */
export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Topbar onMenuClick={() => setSidebarOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col bg-surface-muted">
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
              <Outlet />
            </div>
          </main>
          <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border bg-surface px-4 text-xs sm:px-6">
            <span className="font-medium text-teal">
              {SCHOOL.name}, {SCHOOL.location}
            </span>
            <span className="text-ink-subtle">School portal</span>
          </footer>
        </div>
      </div>
    </div>
  )
}
