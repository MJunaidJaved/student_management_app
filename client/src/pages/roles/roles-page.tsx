import { useState } from 'react'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, Thead, Tbody, Tr, Th, Td } from '@/components/ui/table'
import { EmptyState, PageLoading, ErrorState } from '@/components/ui/feedback'
import { useApiQuery } from '@/hooks/use-api-query'
import { useAuth } from '@/lib/auth-context'
import { RequirePermission } from '@/components/protected-route'
import type { RoleView } from './types'
import { CreateRoleDialog } from './create-role-dialog'
import { RoleDetailDialog } from './role-detail-dialog'

export function RolesPage() {
  const { hasPermission } = useAuth()
  const [createOpen, setCreateOpen] = useState(false)
  const [activeRole, setActiveRole] = useState<RoleView | null>(null)
  const roles = useApiQuery<{ roles: RoleView[] }>(['roles'], '/roles')

  return (
    <RequirePermission anyOf={['roles.read']}>
      <div>
        <PageHeader
          title="Roles & Permissions"
          description="Manage roles and the permissions each one grants."
          actions={
            hasPermission('roles.create') && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" />
                New Role
              </Button>
            )
          }
        />

        <Card>
          {roles.isLoading ? (
            <PageLoading />
          ) : roles.isError ? (
            <ErrorState description="Could not load roles." />
          ) : !roles.data || roles.data.roles.length === 0 ? (
            <EmptyState title="No roles found" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Description</Th>
                  <Th>Users</Th>
                  <Th>Permissions</Th>
                  <Th>Type</Th>
                </Tr>
              </Thead>
              <Tbody>
                {roles.data.roles.map((r) => (
                  <Tr key={r.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => setActiveRole(r)}>
                    <Td className="font-medium text-brand-600">{r.name}</Td>
                    <Td>{r.description ?? '—'}</Td>
                    <Td>{r.userCount}</Td>
                    <Td>{r.permissionCount}</Td>
                    <Td>{r.isSystem && <Badge tone="info">System</Badge>}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        {createOpen && <CreateRoleDialog onClose={() => setCreateOpen(false)} />}
        {activeRole && <RoleDetailDialog role={activeRole} onClose={() => setActiveRole(null)} />}
      </div>
    </RequirePermission>
  )
}
