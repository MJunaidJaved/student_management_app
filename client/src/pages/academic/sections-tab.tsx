import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/input'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useAcademicLookups } from '@/hooks/use-academic-lookups'
import { useAuth } from '@/lib/auth-context'

type FormValues = { classId: string; name: string; capacity: number }

export function SectionsTab() {
  const { classes, sections } = useAcademicLookups()
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { register, handleSubmit, reset } = useForm<FormValues>()

  const create = useMutation({
    mutationFn: async (values: FormValues) => apiClient.post('/academic/sections', { ...values, capacity: Number(values.capacity) }),
    onSuccess: () => {
      reset()
      queryClient.invalidateQueries({ queryKey: ['academic', 'sections'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <div className="space-y-4">
      {hasPermission('academic.manage_classes') && (
        <Card className="p-4">
          <form onSubmit={handleSubmit((v) => create.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Class</Label>
              <Select className="w-44" {...register('classId', { required: true })}>
                <option value="">Select class…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Section Name</Label>
              <Input placeholder="A" {...register('name', { required: true })} />
            </div>
            <div>
              <Label>Capacity</Label>
              <Input type="number" min={1} max={500} {...register('capacity', { required: true, valueAsNumber: true })} />
            </div>
            <Button type="submit" loading={create.isPending}>
              Add Section
            </Button>
          </form>
        </Card>
      )}

      <Card>
        {sections.length === 0 ? (
          <EmptyState title="No sections yet" />
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Class</Th>
                <Th>Section</Th>
                <Th>Capacity</Th>
                <Th>Strength</Th>
              </Tr>
            </Thead>
            <Tbody>
              {sections.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.className}</Td>
                  <Td className="font-medium text-ink">{s.name}</Td>
                  <Td>{s.capacity}</Td>
                  <Td>{s.strength}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  )
}
