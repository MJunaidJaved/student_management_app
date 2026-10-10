import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type FormValues = { status: 'resigned' | 'terminated'; separationDate: string; reason: string }

export function DeactivateStaffDialog({ staffId, onClose }: { staffId: string; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: { status: 'resigned', separationDate: new Date().toISOString().slice(0, 10), reason: '' },
  })

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      await apiClient.post(`/staff/${staffId}/deactivate`, { ...values, reason: values.reason || undefined })
    },
    onSuccess: () => {
      show('success', 'Staff member deactivated')
      queryClient.invalidateQueries({ queryKey: ['staff', staffId] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Deactivate Staff Member" size="sm">
      <form onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
        <div>
          <Label>Reason</Label>
          <Select {...register('status')}>
            <option value="resigned">Resigned</option>
            <option value="terminated">Terminated</option>
          </Select>
        </div>
        <div>
          <Label>Separation Date</Label>
          <Input type="date" {...register('separationDate')} />
        </div>
        <div>
          <Label>Notes (optional)</Label>
          <Input {...register('reason')} />
        </div>
        <p className="text-xs text-ink-muted">This also disables the linked user account, if any.</p>
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
