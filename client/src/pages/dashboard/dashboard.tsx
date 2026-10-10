import { Users, UserCog, Wallet, AlertCircle } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { PageLoading, EmptyState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

type HeadcountSummary = { summary: { status: string; gender: string; count: number }[] }
type OutstandingSummary = { invoiceCount: number; outstanding: string; overdue: string }
type CollectionSummary = { byMethod: { method: string; count: number; total: string }[] }

function sumActive(summary: { status: string; count: number }[]): number {
  return summary.filter((s) => s.status === 'active').reduce((acc, s) => acc + s.count, 0)
}

function firstOfMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
function money(v: string | number): string {
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

export function DashboardPage() {
  const { hasPermission, me } = useAuth()

  const canStudents = hasPermission('students.read')
  const canStaff = hasPermission('staff.read')
  const canFees = hasPermission('fees.read_collection_report')
  const canOutstanding = hasPermission('fees.read_defaulters')

  const students = useApiQuery<HeadcountSummary>(['reports', 'students'], '/reports/students', { enabled: canStudents })
  const staff = useApiQuery<HeadcountSummary>(['reports', 'staff'], '/reports/staff', { enabled: canStaff })
  const collection = useApiQuery<CollectionSummary>(
    ['reports', 'fees-collection'],
    `/reports/fees/collection?from=${firstOfMonth()}&to=${todayIso()}`,
    { enabled: canFees },
  )
  const outstanding = useApiQuery<OutstandingSummary>(['reports', 'fees-outstanding'], '/reports/fees/outstanding', {
    enabled: canOutstanding,
  })

  const totalStudents = students.data ? sumActive(students.data.summary) : null
  const totalStaff = staff.data ? sumActive(staff.data.summary) : null
  const totalCollected = collection.data
    ? collection.data.byMethod.reduce((acc, m) => acc + Number(m.total), 0)
    : null

  const chartData = collection.data?.byMethod.map((m) => ({ method: m.method, total: Number(m.total) })) ?? []

  const anyCardVisible = canStudents || canStaff || canFees || canOutstanding

  return (
    <div>
      <PageHeader title={`Welcome back, ${me?.user.username ?? ''}`} description="Here's what's happening across your school today." />

      {!anyCardVisible && (
        <EmptyState
          title="No dashboard data available for your role"
          description="Your account doesn't hold the permissions needed to view these summaries."
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {canStudents && (
          <StatCard
            label="Active Students"
            value={students.isLoading ? '…' : (totalStudents ?? 0)}
            icon={Users}
            accent="blue"
          />
        )}
        {canStaff && (
          <StatCard label="Active Staff" value={staff.isLoading ? '…' : (totalStaff ?? 0)} icon={UserCog} accent="purple" />
        )}
        {canFees && (
          <StatCard
            label="Collected This Month"
            value={collection.isLoading ? '…' : money(totalCollected ?? 0)}
            icon={Wallet}
            accent="success"
            sublabel={`${firstOfMonth()} – ${todayIso()}`}
          />
        )}
        {canOutstanding && (
          <StatCard
            label="Outstanding Fees"
            value={outstanding.isLoading ? '…' : money(outstanding.data?.outstanding ?? 0)}
            icon={AlertCircle}
            accent="red"
            sublabel={outstanding.data ? `${outstanding.data.invoiceCount} invoice(s)` : undefined}
          />
        )}
      </div>

      {canFees && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Collections by Payment Method — this month</CardTitle>
          </CardHeader>
          <CardContent>
            {collection.isLoading ? (
              <PageLoading />
            ) : chartData.length === 0 ? (
              <EmptyState title="No payments recorded yet this month" />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="method" tick={{ fontSize: 12 }} stroke="var(--color-ink-subtle)" />
                  <YAxis tick={{ fontSize: 12 }} stroke="var(--color-ink-subtle)" />
                  <Tooltip
                    contentStyle={{ borderRadius: 8, border: '1px solid var(--color-border)', fontSize: 12 }}
                    formatter={(v) => money(Number(v))}
                  />
                  <Bar dataKey="total" fill="var(--color-brand-500)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
