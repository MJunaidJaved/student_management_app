import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/auth-context'
import { PageLoading } from '@/components/ui/feedback'

export function ProtectedRoute() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center">
        <PageLoading />
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

/** Wraps a page/section that needs a specific permission. Renders nothing visible — a 403 page — if missing. */
export function RequirePermission({ anyOf, children }: { anyOf: string[]; children: React.ReactNode }) {
  const { hasAnyPermission } = useAuth()
  if (anyOf.length > 0 && !hasAnyPermission(anyOf)) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-ink">You don't have access to this page</p>
        <p className="text-xs text-ink-muted">Ask an administrator if you believe this is a mistake.</p>
      </div>
    )
  }
  return <>{children}</>
}
