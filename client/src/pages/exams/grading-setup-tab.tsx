import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { GradingRangeView, GradingScaleView } from './types'

function RangesCard({ scale }: { scale: GradingScaleView }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const ranges = useApiQuery<{ ranges: GradingRangeView[] }>(['exams', 'ranges', scale.id], `/grading-scales/${scale.id}/ranges`)
  const { register, handleSubmit, reset } = useForm<{ minPercent: string; maxPercent: string; grade: string; gpaPoints: string; remark: string }>()

  const create = useMutation({
    mutationFn: async (v: { minPercent: string; maxPercent: string; grade: string; gpaPoints: string; remark: string }) =>
      apiClient.post('/grading-scale-ranges', {
        gradingScaleId: scale.id,
        minPercent: v.minPercent,
        maxPercent: v.maxPercent,
        grade: v.grade,
        gpaPoints: v.gpaPoints || undefined,
        remark: v.remark || undefined,
      }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['exams', 'ranges', scale.id] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/grading-scale-ranges/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exams', 'ranges', scale.id] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">{scale.name}</h4>
        {scale.isDefault && <Badge tone="success">Default</Badge>}
      </div>

      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <Label>Min %</Label>
          <Input type="number" step="0.01" className="w-20" {...register('minPercent', { required: true })} />
        </div>
        <div>
          <Label>Max %</Label>
          <Input type="number" step="0.01" className="w-20" {...register('maxPercent', { required: true })} />
        </div>
        <div>
          <Label>Grade</Label>
          <Input className="w-20" {...register('grade', { required: true })} />
        </div>
        <div>
          <Label>GPA (optional)</Label>
          <Input type="number" step="0.01" className="w-20" {...register('gpaPoints')} />
        </div>
        <div className="min-w-[140px] flex-1">
          <Label>Remark (optional)</Label>
          <Input {...register('remark')} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      {ranges.isLoading ? (
        <PageLoading />
      ) : !ranges.data || ranges.data.ranges.length === 0 ? (
        <EmptyState title="No grade ranges defined yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Range</Th>
              <Th>Grade</Th>
              <Th>GPA</Th>
              <Th>Remark</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {ranges.data.ranges.map((r) => (
              <Tr key={r.id}>
                <Td>
                  {r.minPercent}% – {r.maxPercent}%
                </Td>
                <Td className="font-medium text-ink">{r.grade}</Td>
                <Td>{r.gpaPoints ?? '—'}</Td>
                <Td>{r.remark ?? '—'}</Td>
                <Td>
                  <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(r.id)}>
                    Delete
                  </Button>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </Card>
  )
}

export function GradingSetupTab() {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const scales = useApiQuery<{ scales: GradingScaleView[] }>(['exams', 'scales'], '/grading-scales')
  const [selected, setSelected] = useState<string | null>(null)
  const { register, handleSubmit, reset } = useForm<{ name: string }>()

  const create = useMutation({
    mutationFn: async (v: { name: string }) => apiClient.post('/grading-scales', v),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['exams', 'scales'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const setDefault = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/grading-scales/${id}/set-default`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['exams', 'scales'] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const active = scales.data?.scales.find((s) => s.id === selected) ?? scales.data?.scales[0]

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">Grading Scales</h3>
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1">
            <Label>Name</Label>
            <Input placeholder="Standard A-F" {...register('name', { required: true })} />
          </div>
          <Button type="submit" loading={create.isPending}>
            Add
          </Button>
        </form>

        {scales.isLoading ? (
          <PageLoading />
        ) : !scales.data || scales.data.scales.length === 0 ? (
          <EmptyState title="No grading scales yet" />
        ) : (
          <div className="flex flex-wrap gap-2">
            {scales.data.scales.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s.id)}
                className={`rounded-full border px-3 py-1 text-sm ${active?.id === s.id ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-border text-ink-muted hover:bg-surface-muted'}`}
              >
                {s.name}
                {s.isDefault && ' ★'}
              </button>
            ))}
            {active && !active.isDefault && (
              <Button variant="outline" size="sm" loading={setDefault.isPending} onClick={() => setDefault.mutate(active.id)}>
                Make Default
              </Button>
            )}
          </div>
        )}
      </Card>

      {active && <RangesCard scale={active} />}
    </div>
  )
}
