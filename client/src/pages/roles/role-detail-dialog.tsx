import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { PageLoading } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import type { PermissionCatalog, RoleDetail, RoleView } from './types'

export function RoleDetailDialog({ role, onClose }: { role: RoleView; onClose: () => void }) {
  const { hasPermission } = useAuth()
  const { show } = useToast()
  const queryClient = useQueryClient()
  const canUpdate = hasPermission('roles.update') && !role.isSystem
  const canDelete = hasPermission('roles.delete') && !role.isSystem

  const detail = useApiQuery<RoleDetail>(['roles', role.id], `/roles/${role.id}`)
  const catalog = useApiQuery<{ modules: PermissionCatalog }>(['permissions'], '/permissions')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (detail.data) setSelected(new Set(detail.data.permissions))
  }, [detail.data])

  const { register, handleSubmit } = useForm<{ name: string; description: string }>({
    values: { name: role.name, description: role.description ?? '' },
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['roles'] })
    queryClient.invalidateQueries({ queryKey: ['roles', role.id] })
  }

  const rename = useMutation({
    mutationFn: async (v: { name: string; description: string }) => apiClient.patch(`/roles/${role.id}`, { name: v.name, description: v.description || null }),
    onSuccess: () => {
      show('success', 'Role updated')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const savePermissions = useMutation({
    mutationFn: async () => apiClient.put(`/roles/${role.id}/permissions`, { permissions: [...selected] }),
    onSuccess: () => {
      show('success', 'Permissions updated')
      invalidate()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  const remove = useMutation({
    mutationFn: async () => apiClient.delete(`/roles/${role.id}`),
    onSuccess: () => {
      show('success', 'Role deleted')
      invalidate()
      onClose()
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  function toggle(code: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  return (
    <Dialog open onClose={onClose} title={`Role — ${role.name}`} size="lg">
      {detail.isLoading || catalog.isLoading ? (
        <PageLoading />
      ) : (
        <div className="space-y-5">
          <form onSubmit={handleSubmit((v) => rename.mutate(v))} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <Label>Name</Label>
              <Input disabled={!canUpdate} {...register('name', { required: true })} />
            </div>
            <div className="min-w-[200px] flex-1">
              <Label>Description</Label>
              <Input disabled={!canUpdate} {...register('description')} />
            </div>
            {canUpdate && (
              <Button type="submit" size="sm" loading={rename.isPending}>
                Save
              </Button>
            )}
          </form>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>Permissions</Label>
              {canUpdate && (
                <Button size="sm" loading={savePermissions.isPending} onClick={() => savePermissions.mutate()}>
                  Save Permissions
                </Button>
              )}
            </div>
            <div className="max-h-96 space-y-4 overflow-y-auto rounded-lg border border-border p-3">
              {Object.entries(catalog.data?.modules ?? {}).map(([mod, perms]) => (
                <div key={mod}>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{mod}</h4>
                  <div className="grid grid-cols-2 gap-1">
                    {perms.map((p) => (
                      <label key={p.code} className="flex items-center gap-2 text-sm text-ink">
                        <input type="checkbox" disabled={!canUpdate} checked={selected.has(p.code)} onChange={() => toggle(p.code)} />
                        <span title={p.description ?? undefined}>{p.code}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-between pt-2">
            {canDelete ? (
              <Button variant="danger" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                <Trash2 className="size-4" />
                Delete Role
              </Button>
            ) : (
              <span />
            )}
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
