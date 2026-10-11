import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { AccountHeadView } from './types'

type Line = { accountHeadId: string; debit: string; credit: string }

export function CreateVoucherDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const heads = useApiQuery<{ accountHeads: AccountHeadView[] }>(['accounting', 'heads'], '/account-heads')
  const { register, handleSubmit } = useForm<{ type: string; voucherDate: string; narration: string }>({
    defaultValues: { type: 'journal', voucherDate: new Date().toISOString().slice(0, 10) },
  })
  const [lines, setLines] = useState<Line[]>([
    { accountHeadId: '', debit: '', credit: '' },
    { accountHeadId: '', debit: '', credit: '' },
  ])

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0)
  const balanced = lines.length >= 2 && totalDebit > 0 && totalDebit === totalCredit

  function updateLine(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }

  const create = useMutation({
    mutationFn: async (v: { type: string; voucherDate: string; narration: string }) =>
      apiClient.post('/vouchers', {
        type: v.type,
        voucherDate: v.voucherDate,
        narration: v.narration || undefined,
        entries: lines
          .filter((l) => l.accountHeadId && (l.debit || l.credit))
          .map((l) => ({ accountHeadId: l.accountHeadId, debit: l.debit || undefined, credit: l.credit || undefined })),
      }),
    onSuccess: () => {
      show('success', 'Draft voucher created')
      queryClient.invalidateQueries({ queryKey: ['accounting', 'vouchers'] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="New Voucher" size="lg">
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select {...register('type')}>
              <option value="journal">Journal</option>
              <option value="receipt">Receipt</option>
              <option value="payment">Payment</option>
            </Select>
          </div>
          <div>
            <Label>Date</Label>
            <Input type="date" {...register('voucherDate', { required: true })} />
          </div>
        </div>
        <div>
          <Label>Narration (optional)</Label>
          <Input {...register('narration')} />
        </div>

        <div>
          <Label>Entries (must balance)</Label>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <Select className="min-w-[160px] flex-1" value={line.accountHeadId} onChange={(e) => updateLine(i, { accountHeadId: e.target.value })}>
                  <option value="">Account head…</option>
                  {heads.data?.accountHeads.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.code} — {h.name}
                    </option>
                  ))}
                </Select>
                <Input type="number" step="0.01" placeholder="Debit" className="w-28" value={line.debit} onChange={(e) => updateLine(i, { debit: e.target.value, credit: '' })} />
                <Input type="number" step="0.01" placeholder="Credit" className="w-28" value={line.credit} onChange={(e) => updateLine(i, { credit: e.target.value, debit: '' })} />
                <Button type="button" variant="ghost" size="icon" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                  <Trash2 className="size-4 text-danger-500" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setLines((ls) => [...ls, { accountHeadId: '', debit: '', credit: '' }])}>
            <Plus className="size-4" />
            Add Line
          </Button>
          <p className={`mt-2 text-xs ${balanced ? 'text-success-600' : 'text-danger-500'}`}>
            Debit {totalDebit.toFixed(2)} / Credit {totalCredit.toFixed(2)} {balanced ? '— balanced' : '— must balance before posting'}
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create Draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
