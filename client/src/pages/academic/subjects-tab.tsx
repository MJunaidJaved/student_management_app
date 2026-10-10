import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'

type Subject = { id: string; code: string; name: string; type: string }
type FormValues = { code: string; name: string; type: 'core' | 'elective' | 'co_curricular' }

export function SubjectsTab() {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<FormValues>({ defaultValues: { type: 'core' } })

  const subjects = useApiQuery<{ subjects: Subject[] }>(['academic', 'subjects'], '/academic/subjects')

  const create = useMutation({
    mutationFn: async (values: FormValues) => apiClient.post('/academic/subjects', values),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['academic', 'subjects'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div className="space-y-4">
      {hasPermission('academic.manage_subjects') && (
        <Card className="p-4">
          <form onSubmit={handleSubmit((v) => create.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Code</Label>
              <Input placeholder="MATH9" {...register('code', { required: true })} />
            </div>
            <div className="min-w-[160px] flex-1">
              <Label>Name</Label>
              <Input placeholder="Mathematics" {...register('name', { required: true })} />
            </div>
            <div>
              <Label>Type</Label>
              <Select {...register('type')}>
                <option value="core">Core</option>
                <option value="elective">Elective</option>
                <option value="co_curricular">Co-curricular</option>
              </Select>
            </div>
            <Button type="submit" loading={create.isPending}>
              Add Subject
            </Button>
          </form>
        </Card>
      )}

      <Card>
        {subjects.isLoading ? (
          <PageLoading />
        ) : !subjects.data || subjects.data.subjects.length === 0 ? (
          <EmptyState title="No subjects yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>Type</Th>
              </Tr>
            </Thead>
            <Tbody>
              {subjects.data.subjects.map((s) => (
                <Tr key={s.id}>
                  <Td className="font-medium text-brand-600">{s.code}</Td>
                  <Td>{s.name}</Td>
                  <Td>
                    <Badge tone="neutral">{s.type.replace('_', '-')}</Badge>
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
