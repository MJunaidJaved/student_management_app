import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'

type FormValues = { name: string; levelOrder: number }

export function ClassesTab() {
  const { classes } = useAcademicLookups()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (values: FormValues) => apiClient.post('/academic/classes', { ...values, levelOrder: Number(values.levelOrder) }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['academic', 'classes'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div className="space-y-4">
      {hasPermission('academic.manage_classes') && (
        <Card className="p-4">
          <form onSubmit={handleSubmit((v) => create.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Label>Name</Label>
              <Input placeholder="Class 9" {...register('name', { required: true })} />
            </div>
            <div>
              <Label>Level Order</Label>
              <Input type="number" min={0} max={100} {...register('levelOrder', { required: true, valueAsNumber: true })} />
            </div>
            <Button type="submit" loading={create.isPending}>
              Add Class
            </Button>
          </form>
        </Card>
      )}

      <Card>
        {classes.length === 0 ? (
          <EmptyState title="No classes yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Level Order</Th>
              </Tr>
            </Thead>
            <Tbody>
              {[...classes]
                .sort((a, b) => a.levelOrder - b.levelOrder)
                .map((c) => (
                  <Tr key={c.id}>
                    <Td className="font-medium text-ink">{c.name}</Td>
                    <Td>{c.levelOrder}</Td>
                  </Tr>
                ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
