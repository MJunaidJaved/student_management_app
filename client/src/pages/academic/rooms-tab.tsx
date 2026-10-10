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
import { useAuth } from '@/lib/auth-context'

type Room = { id: string; name: string; roomType: string; capacity: number | null }
type FormValues = { name: string; roomType: string; capacity?: number }

export function RoomsTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<FormValues>()

  const rooms = useApiQuery<{ rooms: Room[] }>(['academic', 'rooms'], '/academic/rooms')

  const create = useMutation({
    mutationFn: async (values: FormValues) =>
      apiClient.post('/academic/rooms', { ...values, capacity: values.capacity ? Number(values.capacity) : undefined }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['academic', 'rooms'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div className="space-y-4">
      {hasPermission('academic.manage_rooms') && (
        <Card className="p-4">
          <form onSubmit={handleSubmit((v) => create.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Label>Name</Label>
              <Input placeholder="Lab 1" {...register('name', { required: true })} />
            </div>
            <div>
              <Label>Type</Label>
              <Input placeholder="lab, classroom, hall…" {...register('roomType', { required: true })} />
            </div>
            <div>
              <Label>Capacity</Label>
              <Input type="number" min={1} {...register('capacity', { valueAsNumber: true })} />
            </div>
            <Button type="submit" loading={create.isPending}>
              Add Room
            </Button>
          </form>
        </Card>
      )}

      <Card>
        {rooms.isLoading ? (
          <PageLoading />
        ) : !rooms.data || rooms.data.rooms.length === 0 ? (
          <EmptyState title="No rooms yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Capacity</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rooms.data.rooms.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-medium text-ink">{r.name}</Td>
                  <Td className="capitalize">{r.roomType}</Td>
                  <Td>{r.capacity ?? '—'}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
