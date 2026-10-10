import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, UserPlus, LogOut, Users as UsersIcon } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import { useToast } from '@/components/ui/toast'
import type { StudentDetail } from './types'
import { StudentEditDialog } from './student-edit-dialog'
import { LinkGuardianDialog } from './link-guardian-dialog'
import { WithdrawDialog } from './withdraw-dialog'

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="mt-0.5 text-sm text-ink">{value ?? '—'}</p>
    </div>
  )
}

export function StudentDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { classes, sections } = useAcademicLookups()

  const [editOpen, setEditOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [withdrawOpen, setWithdrawOpen] = useState(false)

  const detail = useApiQuery<StudentDetail>(['students', id], `/students/${id}`)
  const siblings = useApiQuery<{ siblings: { id: string; admissionNo: string; firstName: string; lastName: string | null }[] }>(
    ['students', id, 'siblings'],
    `/students/${id}/siblings`,
  )

  const unlinkGuardian = useMutation({
    mutationFn: async (guardianId: string) => {
      await apiClient.delete(`/students/${id}/guardians/${guardianId}`)
    },
    onSuccess: () => {
      show('success', 'Guardian unlinked')
      queryClient.invalidateQueries({ queryKey: ['students', id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (detail.isLoading) return <PageLoading />
  if (detail.isError || !detail.data) return <ErrorState description="Could not load this student." />

  const s = detail.data
  const section = sections.find((sec) => sec.id === s.enrollment?.sectionId)
  const cls = classes.find((c) => c.id === s.enrollment?.classId)

  return (
    <RequirePermission anyOf={['students.read']}>
      <div className="mx-auto max-w-4xl">
        <Button variant="ghost" size="sm" onClick={() => navigate('/students')} className="mb-2">
          <ArrowLeft className="size-4" />
          Back to Students
        </Button>

        <PageHeader
          title={`${s.firstName} ${s.lastName ?? ''}`}
          description={`Admission No. ${s.admissionNo}`}
          actions={
            <>
              <Badge tone={statusTone(s.status)} className="mr-2">
                {s.status}
              </Badge>
              {hasPermission('students.update') && (
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
              )}
              {hasPermission('students.leave_school') && s.status === 'active' && (
                <Button variant="danger" size="sm" onClick={() => setWithdrawOpen(true)}>
                  <LogOut className="size-4" />
                  Withdraw
                </Button>
              )}
            </>
          }
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Gender" value={s.gender} />
              <Field label="Date of Birth" value={s.dob} />
              <Field label="Admission Date" value={s.admissionDate} />
              <Field label="Phone" value={s.phone} />
              <Field label="National ID" value={s.nationalId} />
              <Field label="Blood Group" value={s.bloodGroup} />
              <Field label="Religion" value={s.religion} />
              <Field label="Previous School" value={s.previousSchool} />
              <div className="col-span-2 sm:col-span-3">
                <Field label="Address" value={s.address} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Current Enrollment</CardTitle>
            </CardHeader>
            <CardContent>
              {s.enrollment ? (
                <div className="space-y-3">
                  <Field label="Class" value={cls?.name} />
                  <Field label="Section" value={section?.name} />
                  <Field label="Roll No." value={s.enrollment.rollNo} />
                  <Field label="Status" value={s.enrollment.status} />
                </div>
              ) : (
                <p className="text-sm text-ink-muted">Not currently enrolled in any section.</p>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Guardians</CardTitle>
              {hasPermission('students.update') && (
                <Button variant="outline" size="sm" onClick={() => setLinkOpen(true)}>
                  <UserPlus className="size-4" />
                  Link Guardian
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {s.guardians.length === 0 ? (
                <p className="text-sm text-ink-muted">No guardians linked yet.</p>
              ) : (
                s.guardians.map((g) => (
                  <div key={g.linkId} className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div>
                      <p className="text-sm font-medium text-ink">{g.fullName}</p>
                      <p className="text-xs text-ink-muted">
                        {g.phone} · <span className="capitalize">{g.relation}</span>
                        {g.isPrimary && ' · Primary'}
                        {g.isFeePayer && ' · Fee payer'}
                      </p>
                    </div>
                    {hasPermission('students.update') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={unlinkGuardian.isPending}
                        onClick={() => unlinkGuardian.mutate(g.id)}
                      >
                        Unlink
                      </Button>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Siblings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!siblings.data || siblings.data.siblings.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-ink-muted">
                  <UsersIcon className="size-4" />
                  No siblings on record.
                </p>
              ) : (
                siblings.data.siblings.map((sib) => (
                  <Link
                    key={sib.id}
                    to={`/students/${sib.id}`}
                    className="block rounded-lg border border-border p-2 text-sm text-ink hover:bg-surface-muted"
                  >
                    {sib.firstName} {sib.lastName ?? ''}{' '}
                    <span className="text-xs text-ink-subtle">({sib.admissionNo})</span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {editOpen && <StudentEditDialog student={s} onClose={() => setEditOpen(false)} />}
        {linkOpen && <LinkGuardianDialog studentId={s.id} onClose={() => setLinkOpen(false)} />}
        {withdrawOpen && <WithdrawDialog studentId={s.id} onClose={() => setWithdrawOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
