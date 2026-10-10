import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/lib/auth-context'
import { ToastProvider } from '@/components/ui/toast'
import { ProtectedRoute } from '@/components/protected-route'
import { AppLayout } from '@/components/layout/app-layout'
import { LoginPage } from '@/pages/auth/login'
import { DashboardPage } from '@/pages/dashboard/dashboard'
import { ComingSoonPage } from '@/pages/coming-soon'
import { StudentsListPage } from '@/pages/students/students-list'
import { StudentCreatePage } from '@/pages/students/student-create'
import { StudentDetailPage } from '@/pages/students/student-detail'
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

// Every nav item except Dashboard and Students (built out below) gets a
// placeholder route for now, so the full navigation is browsable rather
// than dead links — built out module by module in later passes.
const placeholderRoutes = NAV_GROUPS.flatMap((g) => g.items).filter(
  (item) => item.path !== '/' && item.path !== '/students',
)

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<DashboardPage />} />

                  <Route path="/students" element={<StudentsListPage />} />
                  <Route path="/students/new" element={<StudentCreatePage />} />
                  <Route path="/students/:id" element={<StudentDetailPage />} />

                  {placeholderRoutes.map((item) => (
                    <Route key={item.path} path={item.path} element={<ComingSoonPage title={item.label} />} />
                  ))}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
