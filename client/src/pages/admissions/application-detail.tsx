import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, UserPlus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge, statusTone } from '@/components/ui/badge'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import { useToast } from '@/components/ui/toast'
import type { AdmissionApplicationView, ApplicationStatus } from './types'
import { APPLICATION_TRANSITIONS } from './types'
import { ConvertDialog } from './convert-dialog'

export function ApplicationDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { classes } = useAcademicLookups()
  const [convertOpen, setConvertOpen] = useState(false)

  const application = useApiQuery<AdmissionApplicationView>(['admissions', id], `/applications/${id}`)

  const decide = useMutation({
    mutationFn: async (status: ApplicationStatus) => apiClient.patch(`/applications/${id}/status`, { status }),
    onSuccess: () => {
      show('success', 'Status updated')
      queryClient.invalidateQueries({ queryKey: ['admissions', id] })
      queryClient.invalidateQueries({ queryKey: ['admissions'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  if (application.isLoading) return <PageLoading />
  if (application.isError || !application.data) return <ErrorState description="Could not load this application." />

  const a = application.data
  const nextStatuses = APPLICATION_TRANSITIONS[a.status]
  const canDecide = hasPermission('admissions.decide')
  const canConvert = hasPermission('admissions.enroll') && a.status === 'accepted'

  return (
    <RequirePermission anyOf={['admissions.read']}>
    <div className="mx-auto max-w-2xl">
      <Button variant="ghost" size="sm" onClick={() => navigate('/admissions')} className="mb-2">
        <ArrowLeft className="size-4" />
        Back to Admissions
      </Button>

      <PageHeader
        title={a.applicantName}
        description={a.applicationNo}
        actions={
          <>
            <Badge tone={statusTone(a.status)} className="mr-2">
              {a.status}
            </Badge>
            {canConvert && (
              <Button size="sm" onClick={() => setConvertOpen(true)}>
                <UserPlus className="size-4" />
                Convert to Student
              </Button>
            )}
          </>
        }
      />

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs text-ink-subtle">Date of Birth</p>
            <p className="text-ink">{a.dob}</p>
          </div>
          <div>
            <p className="text-xs text-ink-subtle">Gender</p>
            <p className="text-ink capitalize">{a.gender ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs text-ink-subtle">Applied Class</p>
            <p className="text-ink">{classes.find((c) => c.id === a.appliedClassId)?.name ?? a.appliedClassId}</p>
          </div>
          <div>
            <p className="text-xs text-ink-subtle">Guardian</p>
            <p className="text-ink">
              {a.guardianName} ({a.guardianPhone})
            </p>
          </div>
          {a.remarks && (
            <div className="col-span-2">
              <p className="text-xs text-ink-subtle">Remarks</p>
              <p className="text-ink">{a.remarks}</p>
            </div>
          )}
          {a.studentId && (
            <div className="col-span-2">
              <p className="text-xs text-ink-subtle">Enrolled Student</p>
              <Button variant="ghost" size="sm" className="px-0" onClick={() => navigate(`/students/${a.studentId}`)}>
                View student profile →
              </Button>
            </div>
          )}
        </div>

        {canDecide && nextStatuses.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            {nextStatuses.map((s) => (
              <Button key={s} variant={s === 'rejected' ? 'danger' : 'primary'} size="sm" loading={decide.isPending} onClick={() => decide.mutate(s)}>
                Mark {s}
              </Button>
            ))}
          </div>
        )}
      </Card>

      {convertOpen && <ConvertDialog application={a} onClose={() => setConvertOpen(false)} />}
    </div>
    </RequirePermission>
  )
}
