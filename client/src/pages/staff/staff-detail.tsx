import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Pencil, UserX } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useStaffLookups } from '@/hooks/use-staff-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { StaffView } from './types'
import { StaffEditDialog } from './staff-edit-dialog'
import { DeactivateStaffDialog } from './deactivate-staff-dialog'

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className="mt-0.5 text-sm text-ink">{value ?? '—'}</p>
    </div>
  )
}

export function StaffDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { departments, designations } = useStaffLookups()

  const [editOpen, setEditOpen] = useState(false)
  const [deactivateOpen, setDeactivateOpen] = useState(false)

  const detail = useApiQuery<StaffView>(['staff', id], `/staff/${id}`)

  if (detail.isLoading) return <PageLoading />
  if (detail.isError || !detail.data) return <ErrorState description="Could not load this staff record." />

  const s = detail.data
  const dept = departments.find((d) => d.id === s.departmentId)
  const desig = designations.find((d) => d.id === s.designationId)

  return (
    <RequirePermission anyOf={['staff.read', 'staff.read_own']}>
      <div className="mx-auto max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => navigate('/staff')} className="mb-2">
          <ArrowLeft className="size-4" />
          Back to Staff
        </Button>

        <PageHeader
          title={s.fullName}
          description={`Employee No. ${s.employeeNo}`}
          actions={
            <>
              <Badge tone={statusTone(s.status)} className="mr-2">
                {s.status}
              </Badge>
              {hasPermission('staff.update') && (
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
              )}
              {hasPermission('staff.deactivate') && s.status === 'active' && (
                <Button variant="danger" size="sm" onClick={() => setDeactivateOpen(true)}>
                  <UserX className="size-4" />
                  Deactivate
                </Button>
              )}
            </>
          }
        />

        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Gender" value={s.gender} />
            <Field label="Date of Birth" value={s.dob} />
            <Field label="Join Date" value={s.joinDate} />
            <Field label="Phone" value={s.phone} />
            <Field label="Email" value={s.email} />
            <Field label="National ID" value={s.nationalId} />
            <Field label="Department" value={dept?.name} />
            <Field label="Designation" value={desig?.name} />
            <div className="col-span-2 sm:col-span-3">
              <Field label="Address" value={s.address} />
            </div>
            {s.status !== 'active' && (
              <>
                <Field label="Separation Date" value={s.separationDate} />
                <div className="col-span-2">
                  <Field label="Separation Reason" value={s.separationReason} />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {editOpen && <StaffEditDialog staff={s} onClose={() => setEditOpen(false)} />}
        {deactivateOpen && <DeactivateStaffDialog staffId={s.id} onClose={() => setDeactivateOpen(false)} />}
      </div>
    </RequirePermission>
  )
}
