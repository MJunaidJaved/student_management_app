import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Star } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'

type FormValues = { name: string; startDate: string; endDate: string }

export function YearsTab() {
  const { years } = useAcademicLookups()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<FormValues>()

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['academic', 'years'] })
  }

  const create = useMutation({
    mutationFn: async (values: FormValues) => apiClient.post('/academic/years', values),
    onSuccess: () => {
      reset()
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const setCurrent = useMutation({
    mutationFn: async (id: string) => apiClient.post(`/academic/years/${id}/set-current`),
    onSuccess: () => {
      show('success', 'Current academic year updated')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div className="space-y-4">
      {hasPermission('academic.manage_years') && (
        <Card className="p-4">
          <form onSubmit={handleSubmit((v) => create.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Label>Name</Label>
              <Input placeholder="2026-27" {...register('name', { required: true })} />
            </div>
            <div>
              <Label>Start Date</Label>
              <Input type="date" {...register('startDate', { required: true })} />
            </div>
            <div>
              <Label>End Date</Label>
              <Input type="date" {...register('endDate', { required: true })} />
            </div>
            <Button type="submit" loading={create.isPending}>
              Add Year
            </Button>
          </form>
        </Card>
      )}

      <Card>
        {years.length === 0 ? (
          <EmptyState title="No academic years yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Start</Th>
                <Th>End</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {years.map((y) => (
                <Tr key={y.id}>
                  <Td className="font-medium text-ink">{y.name}</Td>
                  <Td>{y.startDate}</Td>
                  <Td>{y.endDate}</Td>
                  <Td>
                    {y.isCurrent && <Badge tone="success">Current</Badge>}
                    {y.isClosed && (
                      <Badge tone="neutral" className="ml-1">
                        Closed
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    {!y.isCurrent && !y.isClosed && hasPermission('academic.set_current_year') && (
                      <Button variant="ghost" size="sm" loading={setCurrent.isPending} onClick={() => setCurrent.mutate(y.id)}>
                        <Star className="size-4" />
                        Make current
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
