import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { StudentPicker, type PickableStudent } from '@/components/student-picker'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import type { FeeInvoiceView } from './types'

type SearchStudent = PickableStudent
type StudentDetail = { firstName: string; lastName: string | null; enrollment: { id: string; classId: string; sectionId: string } | null }

type FormValues = { billingPeriod: string; issueDate: string; dueDate: string }

export function GenerateInvoiceDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [student, setStudent] = useState<(SearchStudent & { enrollmentId?: string }) | null>(null)
  const [loadingStudent, setLoadingStudent] = useState(false)

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      billingPeriod: new Date().toISOString().slice(0, 7),
      issueDate: new Date().toISOString().slice(0, 10),
      dueDate: new Date().toISOString().slice(0, 10),
    },
  })

  async function selectStudent(s: SearchStudent) {
    setLoadingStudent(true)
    try {
      const res = await apiClient.get<{ data: StudentDetail }>(`/students/${s.id}`)
      if (!res.data.data.enrollment) {
        show('error', `${s.firstName} is not currently enrolled in any section`)
        return
      }
      setStudent({ ...s, enrollmentId: res.data.data.enrollment.id })
    } finally {
      setLoadingStudent(false)
    }
  }

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await apiClient.post<{ data: { invoice: FeeInvoiceView; skipped: boolean } }>('/invoices', {
        enrollmentId: student!.enrollmentId,
        ...values,
      })
      return res.data.data
    },
    onSuccess: (data) => {
      show(data.skipped ? 'info' : 'success', data.skipped ? 'An invoice for this period already exists' : 'Invoice generated')
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      onClose()
      navigate(`/fees/invoices/${data.invoice.id}`)
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Generate Invoice" size="sm">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div>
          <Label>Student</Label>
          {student ? (
            <div className="flex items-center justify-between rounded-lg border border-border p-2 text-sm">
              <span>
                {student.firstName} {student.lastName ?? ''} ({student.admissionNo})
              </span>
              <button type="button" className="text-xs text-brand-600" onClick={() => setStudent(null)}>
                Change
              </button>
            </div>
          ) : (
            <StudentPicker onSelect={selectStudent} placeholder="Search for a student…" />
          )}
          {loadingStudent && <p className="mt-1 text-xs text-ink-muted">Loading enrollment…</p>}
        </div>

        <div>
          <Label>Billing Period</Label>
          <Input placeholder="2026-01" {...register('billingPeriod', { required: true })} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Issue Date</Label>
            <Input type="date" {...register('issueDate', { required: true })} />
          </div>
          <div>
            <Label>Due Date</Label>
            <Input type="date" {...register('dueDate', { required: true })} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!student?.enrollmentId}>
            Generate
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
