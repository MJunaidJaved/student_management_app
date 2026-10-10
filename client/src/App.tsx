import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/lib/auth-context'
import { ProtectedRoute } from '@/components/protected-route'
import { AppLayout } from '@/components/layout/app-layout'
import { LoginPage } from '@/pages/auth/login'
import { DashboardPage } from '@/pages/dashboard/dashboard'
import { ComingSoonPage } from '@/pages/coming-soon'
import { NAV_GROUPS } from '@/lib/nav-config'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

// Every nav item except Dashboard gets a placeholder route for now, so the
// full navigation is browsable rather than dead links — built out module by
// module in later passes.
const placeholderRoutes = NAV_GROUPS.flatMap((g) => g.items).filter((item) => item.path !== '/')

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                <Route path="/" element={<DashboardPage />} />
                {placeholderRoutes.map((item) => (
                  <Route key={item.path} path={item.path} element={<ComingSoonPage title={item.label} />} />
                ))}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}
