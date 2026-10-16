import { Link } from 'react-router-dom'
import { Users, UserCog, Wallet, AlertCircle, CalendarCheck, Receipt, UserPlus } from 'lucide-react'
import { SchoolLogo } from '@/components/school-logo'
import { SCHOOL } from '@/lib/school'
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

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function money(v: string | number): string {
  return `Rs ${Number(v).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
}

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function DashboardPage() {
  const { hasPermission, me } = useAuth()
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const canStudents = hasPermission('students.read')
  const canStaff = hasPermission('staff.read')
  const canFees = hasPermission('fees.read_collection_report')
  const canOutstanding = hasPermission('fees.read_defaulters')

  const students = useApiQuery<HeadcountSummary>(['reports', 'students'], '/reports/students', { enabled: canStudents })
  const staff = useApiQuery<HeadcountSummary>(['reports', 'staff'], '/reports/staff', { enabled: canStaff })
  const collection = useApiQuery<CollectionSummary>(
    ['reports', 'fees-collection'],
    `/reports/fees/collection?from=${isoDay(monthStart)}&to=${isoDay(now)}`,
    { enabled: canFees },
  )
  const outstanding = useApiQuery<OutstandingSummary>(['reports', 'fees-outstanding'], '/reports/fees/outstanding', {
    enabled: canOutstanding,
  })

  const totalStudents = students.data ? sumActive(students.data.summary) : null
  const totalStaff = staff.data ? sumActive(staff.data.summary) : null
  const totalCollected = collection.data ? collection.data.byMethod.reduce((acc, m) => acc + Number(m.total), 0) : null

  const collectionData = collection.data?.byMethod.map((m) => ({ method: capitalize(m.method), total: Number(m.total) })) ?? []

  const byGender = Object.entries(
    (students.data?.summary ?? [])
      .filter((s) => s.status === 'active')
      .reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.gender]: (acc[s.gender] ?? 0) + s.count }), {}),
  ).sort((a, b) => b[1] - a[1])

  const monthLabel = now.toLocaleDateString('en-GB', { month: 'long' })
  const anyCardVisible = canStudents || canStaff || canFees || canOutstanding

  const quickActions = [
    { label: 'Mark attendance', to: '/attendance', icon: CalendarCheck, allowed: hasPermission('attendance.mark') },
    { label: 'Collect fee', to: '/fees', icon: Receipt, allowed: hasPermission('fees.collect') },
    { label: 'Add student', to: '/students', icon: UserPlus, allowed: hasPermission('students.create') },
  ].filter((a) => a.allowed)

  return (
    <div>
      <section className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-brand-500 via-brand-600 to-brand-800 px-6 py-6 text-white shadow-[var(--shadow-raised)] sm:px-8 sm:py-7">
        <div className="pointer-events-none absolute -right-10 -top-10 size-64 rounded-full bg-white opacity-[0.06]" />
        <div className="pointer-events-none absolute -right-2 top-1/2 hidden size-44 -translate-y-1/2 overflow-hidden rounded-full opacity-[0.14] md:block">
          <SchoolLogo className="size-full grayscale" />
        </div>
        <div className="relative max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-100/80">{SCHOOL.name}</p>
          <h1 className="mt-2 text-[26px] font-bold leading-tight tracking-tight">
            {greeting(now.getHours())}, {me?.user.username ?? ''}
          </h1>
          <p className="mt-1 text-sm text-brand-200">
            {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {quickActions.map((a) => (
              <Link
                key={a.to}
                to={a.to}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3.5 text-sm font-semibold text-white ring-1 ring-inset ring-white/15 transition-colors hover:bg-white/20"
              >
                <a.icon className="size-4 text-sky-100" />
                {a.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="brand-ribbon absolute inset-x-0 bottom-0 h-1" />
      </section>

      {!anyCardVisible && (
        <EmptyState
          title="No dashboard data available for your role"
          description="Your account doesn't hold the permissions needed to view these summaries."
        />
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {canStudents && (
          <StatCard label="Active students" value={students.isLoading ? '…' : (totalStudents ?? 0)} icon={Users} accent="blue" />
        )}
        {canStaff && <StatCard label="Active staff" value={staff.isLoading ? '…' : (totalStaff ?? 0)} icon={UserCog} accent="sky" />}
        {canFees && (
          <StatCard
            label={`Collected in ${monthLabel}`}
            value={collection.isLoading ? '…' : money(totalCollected ?? 0)}
            icon={Wallet}
            accent="success"
            sublabel={`1 – ${now.getDate()} ${monthLabel}`}
          />
        )}
        {canOutstanding && (
          <StatCard
            label="Outstanding fees"
            value={outstanding.isLoading ? '…' : money(outstanding.data?.outstanding ?? 0)}
            icon={AlertCircle}
            accent="red"
            sublabel={outstanding.data ? `Across ${outstanding.data.invoiceCount} unpaid invoice(s)` : undefined}
          />
        )}
      </div>

      {(canFees || canStudents) && (
        <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
          {canFees && (
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle>Fee collections by payment method</CardTitle>
                <span className="text-xs text-ink-subtle">{monthLabel}</span>
              </CardHeader>
              <CardContent>
                {collection.isLoading ? (
                  <PageLoading />
                ) : collectionData.length === 0 ? (
                  <EmptyState title={`No payments recorded in ${monthLabel} yet`} />
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={collectionData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.6} vertical={false} />
                      <XAxis dataKey="method" tick={{ fontSize: 12, fill: 'var(--color-ink-muted)' }} axisLine={false} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 12, fill: 'var(--color-ink-subtle)' }}
                        axisLine={false}
                        tickLine={false}
                        width={72}
                        tickFormatter={(v) => Number(v).toLocaleString('en-PK')}
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--color-surface-muted)' }}
                        contentStyle={{ borderRadius: 8, border: '1px solid var(--color-border)', fontSize: 12 }}
                        formatter={(v) => [money(Number(v)), 'Collected']}
                      />
                      <Bar dataKey="total" fill="var(--color-chart-green)" radius={[6, 6, 0, 0]} maxBarSize={56} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          )}

          {canStudents && (
            <Card>
              <CardHeader>
                <CardTitle>Active students by gender</CardTitle>
              </CardHeader>
              <CardContent>
                {students.isLoading ? (
                  <PageLoading />
                ) : byGender.length === 0 ? (
                  <EmptyState title="No active students yet" />
                ) : (
                  <ul className="space-y-4">
                    {byGender.map(([gender, count]) => {
                      const pct = totalStudents ? Math.round((count / totalStudents) * 100) : 0
                      return (
                        <li key={gender}>
                          <div className="mb-1.5 flex items-baseline justify-between text-sm">
                            <span className="font-medium text-ink">{capitalize(gender)}</span>
                            <span className="tabular-nums text-ink-muted">
                              {count.toLocaleString()} <span className="text-ink-subtle">· {pct}%</span>
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                            <div className="h-full rounded-full bg-chart-indigo" style={{ width: `${pct}%` }} />
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
