import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type FormValues = { status: 'withdrawn' | 'transferred' | 'graduated'; leavingDate: string; reason: string }

export function WithdrawDialog({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { status: 'withdrawn', leavingDate: new Date().toISOString().slice(0, 10), reason: '' },
  })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      await apiClient.post(`/students/${studentId}/leave`, { ...values, reason: values.reason || undefined })
    },
    onSuccess: () => {
      show('success', 'Student record updated')
      queryClient.invalidateQueries({ queryKey: ['students', studentId] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Record Withdrawal / Transfer / Graduation" size="sm">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div>
          <Label>Reason</Label>
          <Select {...register('status')}>
            <option value="withdrawn">Withdrawn</option>
            <option value="transferred">Transferred</option>
            <option value="graduated">Graduated</option>
          </Select>
        </div>
        <div>
          <Label>Date</Label>
          <Input type="date" {...register('leavingDate')} />
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Input {...register('reason')} />
        </div>
        <p className="text-xs text-ink-muted">
          This cannot be undone from here. A leaving certificate record is created and the student's status changes
          immediately.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={mutation.isPending}>
            Confirm
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
