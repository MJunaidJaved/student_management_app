import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { PageLoading, ErrorState } from '@/components/ui/feedback'
import { apiClient, apiErrorMessage } from '@/lib/api-client'
import { useToast } from '@/components/ui/toast'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { SettingView } from './types'

function GroupCard({ group, settings, canEdit }: { group: string; settings: SettingView[]; canEdit: boolean }) {
  const { show } = useToast()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState<Set<string>>(new Set())

  useEffect(() => {
    setValues(Object.fromEntries(settings.map((s) => [s.key, s.isSensitive ? '' : s.value])))
    setDirty(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.map((s) => s.value).join('|')])

  const save = useMutation({
    mutationFn: async () => {
      const changed = Object.fromEntries([...dirty].map((k) => [k, values[k] ?? '']))
      await apiClient.patch('/settings', { settings: changed })
    },
    onSuccess: () => {
      show('success', 'Settings saved')
      setDirty(new Set())
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => show('error', apiErrorMessage(err).message),
  })

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="capitalize">{group}</CardTitle>
        {canEdit && dirty.size > 0 && (
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            <Save className="size-4" />
            Save Changes
          </Button>
        )}
      </CardHeader>
      <div className="space-y-3 p-5 pt-3">
        {settings.map((s) => (
          <div key={s.key}>
            <Label>{s.key}</Label>
            <Input
              type={s.isSensitive ? 'password' : 'text'}
              placeholder={s.isSensitive ? '••••••• (unchanged)' : undefined}
              disabled={!canEdit}
              value={values[s.key] ?? ''}
              onChange={(e) => {
                setValues((v) => ({ ...v, [s.key]: e.target.value }))
                setDirty((d) => new Set(d).add(s.key))
              }}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

export function SettingsPage() {
  const { hasPermission } = useAuth()
  const canEdit = hasPermission('settings.update')
  const settings = useApiQuery<{ groups: Record<string, SettingView[]> }>(['settings'], '/settings')

  return (
    <RequirePermission anyOf={['settings.read']}>
      <div>
        <PageHeader title="Settings" description="School profile and system-wide configuration." />
        {settings.isLoading ? (
          <PageLoading />
        ) : settings.isError || !settings.data ? (
          <ErrorState description="Could not load settings." />
        ) : (
          <div className="space-y-4">
            {Object.entries(settings.data.groups).map(([group, items]) => (
              <GroupCard key={group} group={group} settings={items} canEdit={canEdit} />
            ))}
          </div>
        )}
      </div>
    </RequirePermission>
  )
}
