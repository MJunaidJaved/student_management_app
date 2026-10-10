import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label, FieldError } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { EntitySearchBox } from '@/components/entity-search-box'
import type { LeaveTypeView } from './types'

type FormValues = { leaveTypeId: string; fromDate: string; toDate: string; reason: string }
type SearchStudent = { id: string; admissionNo: string; firstName: string; lastName: string | null }

export function NewLeaveRequestDialog({ onClose }: { onClose: () => void }) {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const canRequestForStudent = hasPermission('leave.request')

  const [applicantType, setApplicantType] = useState<'staff' | 'student'>('staff')
  const [student, setStudent] = useState<SearchStudent | null>(null)
  const [enrollmentId, setEnrollmentId] = useState('')
  const [resolvingStudent, setResolvingStudent] = useState(false)

  const leaveTypes = useApiQuery<{ leaveTypes: LeaveTypeView[] }>(['leave', 'types'], '/leave-types')
  const applicable = (leaveTypes.data?.leaveTypes ?? []).filter((t) => t.appliesTo === applicantType || t.appliesTo === 'both')

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>()

  async function selectStudent(s: SearchStudent) {
    setStudent(s)
    setResolvingStudent(true)
    try {
      const res = await apiClient.get<{ data: { enrollment: { id: string } | null } }>(`/students/${s.id}`)
      setEnrollmentId(res.data.data.enrollment?.id ?? '')
      if (!res.data.data.enrollment) show('error', 'This student has no active enrollment')
    } catch (err) {
      show('error', apiErrorMessage(err).message)
    } finally {
      setResolvingStudent(false)
    }
  }

  const submit = useMutation({
    mutationFn: async (v: FormValues) => {
      if (applicantType === 'staff') {
        await apiClient.post('/leave/staff-requests', { leaveTypeId: v.leaveTypeId, fromDate: v.fromDate, toDate: v.toDate, reason: v.reason || undefined })
      } else {
        if (!enrollmentId) throw new Error('Select a student with an active enrollment first')
        await apiClient.post('/leave/student-requests', {
          enrollmentId,
          leaveTypeId: v.leaveTypeId,
          fromDate: v.fromDate,
          toDate: v.toDate,
          reason: v.reason || undefined,
        })
      }
    },
    onSuccess: () => {
      show('success', 'Leave request submitted')
      queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Request Leave" size="md">
      <form onSubmit={handleSubmit((v) => submit.mutate(v))} className="space-y-4">
        {canRequestForStudent && (
          <div>
            <Label>For</Label>
            <div className="flex gap-1">
              <Button type="button" size="sm" variant={applicantType === 'staff' ? 'primary' : 'outline'} onClick={() => setApplicantType('staff')}>
                Myself (Staff)
              </Button>
              <Button type="button" size="sm" variant={applicantType === 'student' ? 'primary' : 'outline'} onClick={() => setApplicantType('student')}>
                A Student
              </Button>
            </div>
          </div>
        )}

        {applicantType === 'student' && (
          <div>
            <Label>Student</Label>
            <EntitySearchBox<SearchStudent>
              endpoint="/search"
              resultsKey="students"
              placeholder="Search by admission no, name, or phone…"
              onSelect={selectStudent}
              renderResult={(s) => (
                <div className="flex items-center justify-between">
                  <span className="text-ink">
                    {s.firstName} {s.lastName ?? ''}
                  </span>
                  <span className="text-xs text-ink-subtle">{s.admissionNo}</span>
                </div>
              )}
            />
            {student && (
              <p className="mt-1 text-xs text-ink-muted">
                Selected: {student.firstName} {student.lastName ?? ''} ({student.admissionNo})
                {resolvingStudent && ' — resolving enrollment…'}
              </p>
            )}
          </div>
        )}

        <div>
          <Label>Leave Type</Label>
          <Select {...register('leaveTypeId', { required: true })}>
            <option value="">Select…</option>
            {applicable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <FieldError>{errors.leaveTypeId && 'Leave type is required'}</FieldError>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>From</Label>
            <Input type="date" {...register('fromDate', { required: true })} />
            <FieldError>{errors.fromDate && 'Required'}</FieldError>
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" {...register('toDate', { required: true })} />
            <FieldError>{errors.toDate && 'Required'}</FieldError>
          </div>
        </div>

        <div>
          <Label>Reason (optional)</Label>
          <Input {...register('reason')} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submit.isPending} disabled={applicantType === 'student' && !enrollmentId}>
            Submit Request
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
