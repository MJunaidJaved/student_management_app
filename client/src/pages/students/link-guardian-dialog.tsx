import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'

type Guardian = { id: string; fullName: string; phone: string }

const RELATIONS = ['father', 'mother', 'guardian', 'brother', 'sister', 'uncle', 'aunt', 'other']

export function LinkGuardianDialog({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'search' | 'new'>('search')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Guardian[]>([])
  const [selected, setSelected] = useState<Guardian | null>(null)
  const [searching, setSearching] = useState(false)

  const { register, handleSubmit } = useForm<{
    relation: string
    isPrimary: boolean
    isFeePayer: boolean
    fullName: string
    phone: string
  }>({ defaultValues: { relation: 'father', isPrimary: false, isFeePayer: false } })

  async function runSearch() {
    if (q.trim().length < 2) return
    setSearching(true)
    try {
      const res = await apiClient.get<{ data: { guardians: Guardian[] } }>('/guardians/search', { params: { q, limit: 10 } })
      setResults(res.data.data.guardians)
    } finally {
      setSearching(false)
    }
  }

  const linkMutation = useMutation({
    mutationFn: async (values: { guardianId: string; relation: string; isPrimary: boolean; isFeePayer: boolean }) => {
      await apiClient.post('/student-guardians', { studentId, ...values })
    },
    onSuccess: () => {
      show('success', 'Guardian linked')
      queryClient.invalidateQueries({ queryKey: ['students', studentId] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const createAndLink = useMutation({
    mutationFn: async (values: { fullName: string; phone: string; relation: string; isPrimary: boolean; isFeePayer: boolean }) => {
      const res = await apiClient.post<{ data: { id: string } }>('/guardians', { fullName: values.fullName, phone: values.phone })
      await apiClient.post('/student-guardians', {
        studentId,
        guardianId: res.data.data.id,
        relation: values.relation,
        isPrimary: values.isPrimary,
        isFeePayer: values.isFeePayer,
      })
    },
    onSuccess: () => {
      show('success', 'Guardian created and linked')
      queryClient.invalidateQueries({ queryKey: ['students', studentId] })
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  function onSubmit(values: { relation: string; isPrimary: boolean; isFeePayer: boolean; fullName: string; phone: string }) {
    if (mode === 'search') {
      if (!selected) return
      linkMutation.mutate({ guardianId: selected.id, relation: values.relation, isPrimary: values.isPrimary, isFeePayer: values.isFeePayer })
    } else {
      createAndLink.mutate(values)
    }
  }

  const pending = linkMutation.isPending || createAndLink.isPending

  return (
    <Dialog open onClose={onClose} title="Link Guardian" size="md">
      <div className="mb-4 flex gap-2">
        <Button type="button" size="sm" variant={mode === 'search' ? 'primary' : 'outline'} onClick={() => setMode('search')}>
          Find existing
        </Button>
        <Button type="button" size="sm" variant={mode === 'new' ? 'primary' : 'outline'} onClick={() => setMode('new')}>
          Create new
        </Button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {mode === 'search' ? (
          <div>
            <Label>Search by name or phone</Label>
            <div className="flex gap-2">
              <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), runSearch())} />
              <Button type="button" variant="outline" onClick={runSearch} loading={searching}>
                <Search className="size-4" />
              </Button>
            </div>
            <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
              {results.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  onClick={() => setSelected(g)}
                  className={`block w-full rounded-lg border p-2 text-left text-sm ${
                    selected?.id === g.id ? 'border-brand-400 bg-brand-50' : 'border-border hover:bg-surface-muted'
                  }`}
                >
                  {g.fullName} <span className="text-xs text-ink-subtle">({g.phone})</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Full Name</Label>
              <Input {...register('fullName', { required: mode === 'new' })} />
            </div>
            <div>
              <Label>Phone</Label>
              <Input {...register('phone', { required: mode === 'new' })} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label>Relation</Label>
            <Select {...register('relation')}>
              {RELATIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          <label className="mt-6 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" {...register('isPrimary')} className="size-4 rounded border-border" />
            Primary
          </label>
          <label className="mt-6 flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" {...register('isFeePayer')} className="size-4 rounded border-border" />
            Fee payer
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending} disabled={mode === 'search' && !selected}>
            Link Guardian
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
