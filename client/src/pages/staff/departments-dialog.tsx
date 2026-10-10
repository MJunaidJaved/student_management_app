import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useStaffLookups } from '@/hooks/use-staff-lookups'

export function DepartmentsDialog({ onClose }: { onClose: () => void }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const { departments, designations } = useStaffLookups()
  const [newDept, setNewDept] = useState('')
  const [newDesig, setNewDesig] = useState('')
  const [newDesigDept, setNewDesigDept] = useState('')

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['staff', 'departments'] })
    queryClient.invalidateQueries({ queryKey: ['staff', 'designations'] })
  }

  const createDept = useMutation({
    mutationFn: async (name: string) => apiClient.post('/departments', { name }),
    onSuccess: () => {
      setNewDept('')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const deleteDept = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/departments/${id}`),
    onSuccess: invalidate,
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const createDesig = useMutation({
    mutationFn: async (vars: { name: string; departmentId: string | null }) => apiClient.post('/designations', vars),
    onSuccess: () => {
      setNewDesig('')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })
  const deleteDesig = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/designations/${id}`),
    onSuccess: invalidate,
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Dialog open onClose={onClose} title="Departments & Designations" size="md">
      <div className="space-y-6">
        <div>
          <p className="mb-2 text-sm font-medium text-ink">Departments</p>
          <div className="mb-2 flex gap-2">
            <Input placeholder="New department name" value={newDept} onChange={(e) => setNewDept(e.target.value)} />
            <Button
              variant="outline"
              loading={createDept.isPending}
              disabled={!newDept.trim()}
              onClick={() => createDept.mutate(newDept)}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {departments.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-1.5 text-sm">
                {d.name}
                <button onClick={() => deleteDept.mutate(d.id)} className="text-ink-subtle hover:text-danger-500">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-ink">Designations</p>
          <div className="mb-2 flex gap-2">
            <Input placeholder="New designation name" value={newDesig} onChange={(e) => setNewDesig(e.target.value)} />
            <Select className="w-40" value={newDesigDept} onChange={(e) => setNewDesigDept(e.target.value)}>
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              loading={createDesig.isPending}
              disabled={!newDesig.trim()}
              onClick={() => createDesig.mutate({ name: newDesig, departmentId: newDesigDept || null })}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {designations.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-1.5 text-sm">
                {d.name}
                <button onClick={() => deleteDesig.mutate(d.id)} className="text-ink-subtle hover:text-danger-500">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
