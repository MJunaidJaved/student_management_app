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
import { StaffListPage } from '@/pages/staff/staff-list'
import { StaffCreatePage } from '@/pages/staff/staff-create'
import { StaffDetailPage } from '@/pages/staff/staff-detail'
import { AcademicSetupPage } from '@/pages/academic/academic-setup'
import { FeesPage } from '@/pages/fees/fees-page'
import { InvoiceDetailPage } from '@/pages/fees/invoice-detail'
import { AttendancePage } from '@/pages/attendance/attendance-page'
import { LeavePage } from '@/pages/leave/leave-page'
import { TimetablePage } from '@/pages/timetable/timetable-page'
import { ExamsPage } from '@/pages/exams/exams-page'
import { ExamDetailPage } from '@/pages/exams/exam-detail'
import { PayrollPage } from '@/pages/payroll/payroll-page'
import { RunDetailPage } from '@/pages/payroll/run-detail'
import { InventoryPage } from '@/pages/inventory/inventory-page'
import { PoDetailPage } from '@/pages/inventory/po-detail'
import { LibraryPage } from '@/pages/library/library-page'
import { TransportPage } from '@/pages/transport/transport-page'
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
const builtPaths = new Set(['/', '/students', '/staff', '/academic', '/fees', '/attendance', '/leave', '/timetable', '/exams', '/payroll', '/inventory', '/library', '/transport'])
const placeholderRoutes = NAV_GROUPS.flatMap((g) => g.items).filter((item) => !builtPaths.has(item.path))

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

                  <Route path="/staff" element={<StaffListPage />} />
                  <Route path="/staff/new" element={<StaffCreatePage />} />
                  <Route path="/staff/:id" element={<StaffDetailPage />} />

                  <Route path="/academic" element={<AcademicSetupPage />} />

                  <Route path="/fees" element={<FeesPage />} />
                  <Route path="/fees/invoices/:id" element={<InvoiceDetailPage />} />

                  <Route path="/attendance" element={<AttendancePage />} />
                  <Route path="/leave" element={<LeavePage />} />
                  <Route path="/timetable" element={<TimetablePage />} />

                  <Route path="/exams" element={<ExamsPage />} />
                  <Route path="/exams/:id" element={<ExamDetailPage />} />

                  <Route path="/payroll" element={<PayrollPage />} />
                  <Route path="/payroll/runs/:id" element={<RunDetailPage />} />

                  <Route path="/inventory" element={<InventoryPage />} />
                  <Route path="/inventory/purchase-orders/:id" element={<PoDetailPage />} />

                  <Route path="/library" element={<LibraryPage />} />

                  <Route path="/transport" element={<TransportPage />} />

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
