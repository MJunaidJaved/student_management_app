import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import type { PeriodView } from './types'

type FormValues = { name: string; startTime: string; endTime: string; sortOrder: string }

export function PeriodsSetupTab() {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const periods = useApiQuery<{ periods: PeriodView[] }>(['timetable', 'periods'], '/periods')
  const { register, handleSubmit, reset } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (v: FormValues) =>
      apiClient.post('/periods', { name: v.name, startTime: v.startTime, endTime: v.endTime, sortOrder: Number(v.sortOrder) }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['timetable', 'periods'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/periods/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['timetable', 'periods'] }),
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const sorted = [...(periods.data?.periods ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">Bell Schedule</h3>
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="mb-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[120px]">
          <Label>Name</Label>
          <Input placeholder="P1" {...register('name', { required: true })} />
        </div>
        <div>
          <Label>Start</Label>
          <Input type="time" {...register('startTime', { required: true })} />
        </div>
        <div>
          <Label>End</Label>
          <Input type="time" {...register('endTime', { required: true })} />
        </div>
        <div>
          <Label>Sort Order</Label>
          <Input type="number" className="w-24" {...register('sortOrder', { required: true })} />
        </div>
        <Button type="submit" loading={create.isPending}>
          Add
        </Button>
      </form>

      {periods.isLoading ? (
        <PageLoading />
      ) : sorted.length === 0 ? (
        <EmptyState title="No periods defined yet" />
      ) : (
        <Table>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Start</Th>
              <Th>End</Th>
              <Th>Order</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {sorted.map((p) => (
              <Tr key={p.id}>
                <Td className="font-medium text-ink">{p.name}</Td>
                <Td>{p.startTime.slice(0, 5)}</Td>
                <Td>{p.endTime.slice(0, 5)}</Td>
                <Td>{p.sortOrder}</Td>
                <Td>
                  <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(p.id)}>
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
