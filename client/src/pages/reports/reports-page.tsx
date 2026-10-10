import { useNavigate } from 'react-router-dom'
import { Boxes, BookOpen, Bus, Landmark } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { PageLoading, EmptyState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'

type HeadcountSummary = { summary: { status: string; gender: string; count: number }[] }

function HeadcountCard({ title, data, isLoading }: { title: string; data?: HeadcountSummary; isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <PageLoading />
        ) : !data || data.summary.length === 0 ? (
          <EmptyState title="No data available" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Status</Th>
                <Th>Gender</Th>
                <Th>Count</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.summary.map((row, i) => (
                <Tr key={i}>
                  <Td className="capitalize">{row.status}</Td>
                  <Td className="capitalize">{row.gender}</Td>
                  <Td>{row.count}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export function ReportsPage() {
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const canStudents = hasPermission('students.read')
  const canStaff = hasPermission('staff.read')

  const students = useApiQuery<HeadcountSummary>(['reports', 'students'], '/reports/students', { enabled: canStudents })
  const staff = useApiQuery<HeadcountSummary>(['reports', 'staff'], '/reports/staff', { enabled: canStaff })

  const quickLinks = [
    { label: 'Low Stock (Inventory)', icon: Boxes, path: '/inventory', permission: 'inventory.read_reports' },
    { label: 'Overdue Books (Library)', icon: BookOpen, path: '/library', permission: 'library.read_reports' },
    { label: 'Fleet Compliance (Transport)', icon: Bus, path: '/transport', permission: 'transport.read_compliance' },
    { label: 'Trial Balance (Accounting)', icon: Landmark, path: '/accounting', permission: 'accounting.read' },
  ].filter((l) => hasPermission(l.permission))

  return (
    <RequirePermission anyOf={['students.read', 'staff.read']}>
      <div>
        <PageHeader title="Reports" description="Headcount breakdowns and quick links to every module's own reports." />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {canStudents && <HeadcountCard title="Students by Status & Gender" data={students.data} isLoading={students.isLoading} />}
          {canStaff && <HeadcountCard title="Staff by Status & Gender" data={staff.data} isLoading={staff.isLoading} />}
        </div>

        {quickLinks.length > 0 && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>More Reports</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 pt-0">
              {quickLinks.map((l) => (
                <Button key={l.path} variant="outline" size="sm" onClick={() => navigate(l.path)}>
                  <l.icon className="size-4" />
                  {l.label}
                </Button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </RequirePermission>
  )
}
